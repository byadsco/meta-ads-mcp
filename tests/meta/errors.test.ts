import { describe, it, expect } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { mapMetaErrorToMcp, isMetaApiError } from "../../src/meta/errors.js";
import type { MetaApiError } from "../../src/meta/types/common.js";

describe("isMetaApiError", () => {
  it("returns true for valid Meta API error response", () => {
    expect(
      isMetaApiError({
        error: { message: "test", type: "OAuthException", code: 190 },
      }),
    ).toBe(true);
  });

  it("returns false for null", () => {
    expect(isMetaApiError(null)).toBe(false);
  });

  it("returns false for non-object", () => {
    expect(isMetaApiError("string")).toBe(false);
  });

  it("returns false for object without error key", () => {
    expect(isMetaApiError({ data: [] })).toBe(false);
  });

  it("returns false for object where error is not an object", () => {
    expect(isMetaApiError({ error: "string" })).toBe(false);
  });

  it("returns true even with minimal error object", () => {
    expect(isMetaApiError({ error: {} })).toBe(true);
  });
});

describe("mapMetaErrorToMcp", () => {
  function makeError(overrides: Partial<MetaApiError>): MetaApiError {
    return {
      message: "Test error",
      type: "OAuthException",
      code: 0,
      ...overrides,
    };
  }

  it("maps auth error code 190 to InvalidRequest", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 190 }));
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(ErrorCode.InvalidRequest);
    expect(err.message).toContain("Invalid or expired access token");
  });

  it("maps permission error code 10 to InvalidRequest", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 10 }));
    expect(err.code).toBe(ErrorCode.InvalidRequest);
    expect(err.message).toContain("Insufficient permissions");
  });

  it("maps auth error code 102 to InvalidRequest", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 102 }));
    expect(err.code).toBe(ErrorCode.InvalidRequest);
    expect(err.message).toContain("Authentication required");
  });

  it("maps rate limit error code 4 to InvalidRequest", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 4 }));
    expect(err.code).toBe(ErrorCode.InvalidRequest);
    expect(err.message).toContain("Rate limit exceeded");
  });

  it("maps rate limit error code 17 to InvalidRequest", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 17 }));
    expect(err.message).toContain("Rate limit exceeded");
  });

  it("maps rate limit error code 32 to InvalidRequest", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 32 }));
    expect(err.message).toContain("Rate limit exceeded");
  });

  it("maps rate limit error code 613 to InvalidRequest", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 613 }));
    expect(err.message).toContain("Rate limit exceeded");
  });

  it("maps invalid parameter code 100 to InvalidParams", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 100 }));
    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toContain("Invalid parameter");
  });

  it("includes subcode in invalid parameter error", () => {
    const err = mapMetaErrorToMcp(
      makeError({ code: 100, error_subcode: 2804008 }),
    );
    expect(err.message).toContain("subcode: 2804008");
  });

  it("maps object not found code 803 to InvalidParams", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 803 }));
    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toContain("Object not found");
  });

  it("maps duplicate error code 2650 to InvalidRequest", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 2650 }));
    expect(err.code).toBe(ErrorCode.InvalidRequest);
    expect(err.message).toContain("Duplicate");
  });

  it("maps server error code 1 to InternalError", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 1 }));
    expect(err.code).toBe(ErrorCode.InternalError);
    expect(err.message).toContain("Please retry");
  });

  it("maps server error code 2 to InternalError", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 2 }));
    expect(err.code).toBe(ErrorCode.InternalError);
  });

  it("maps unknown error codes to InternalError with code number", () => {
    const err = mapMetaErrorToMcp(makeError({ code: 9999 }));
    expect(err.code).toBe(ErrorCode.InternalError);
    expect(err.message).toContain("code 9999");
  });

  it("includes original Meta error message", () => {
    const err = mapMetaErrorToMcp(
      makeError({ code: 190, message: "Token expired at 2024-01-01" }),
    );
    expect(err.message).toContain("Token expired at 2024-01-01");
  });
});
