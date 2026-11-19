import { describe, it, expect } from "vitest";
import {
  carryOverFields,
  cleanDegreesOfFreedomSpec,
  hasFeedContent,
  withInstagramIdentity,
} from "../../src/meta/creative-rebuild.js";
import type { AdCreative } from "../../src/meta/types/index.js";

const base: AdCreative = { id: "4001", name: "C" };

describe("carryOverFields", () => {
  it("carries everything that lives beside the story onto a replacement", () => {
    const creative = {
      ...base,
      link_url: "https://example.com/override",
      destination_spec: { destination_type: "WEBSITE_AND_SHOP_OPT_OUT" },
      wamo_whatsapp_identity_spec: { wamo_whatsapp_identity_id: "7001" },
      contextual_multi_ads: { enroll_status: "OPT_OUT" },
      platform_customizations: { instagram: { image_hash: "ig1" } },
      adlabels: [{ id: "900", name: "L" }, { name: "Only name" }],
    } as AdCreative;

    const { body, warnings } = carryOverFields(creative);

    expect(body).toEqual({
      link_url: "https://example.com/override",
      destination_spec: JSON.stringify({ destination_type: "WEBSITE_AND_SHOP_OPT_OUT" }),
      wamo_whatsapp_identity_spec: JSON.stringify({ wamo_whatsapp_identity_id: "7001" }),
      contextual_multi_ads: JSON.stringify({ enroll_status: "OPT_OUT" }),
      platform_customizations: JSON.stringify({ instagram: { image_hash: "ig1" } }),
      adlabels: JSON.stringify([{ id: "900" }, { name: "Only name" }]),
    });
    expect(warnings).toEqual([]);
  });

  it("drops the deprecated standard_enhancements and says so", () => {
    const { body, warnings } = carryOverFields({
      ...base,
      degrees_of_freedom_spec: {
        creative_features_spec: {
          standard_enhancements: { enroll_status: "OPT_IN" },
          image_touchups: { enroll_status: "OPT_OUT" },
        },
      },
    });

    expect(JSON.parse(body.degrees_of_freedom_spec)).toEqual({
      creative_features_spec: { image_touchups: { enroll_status: "OPT_OUT" } },
    });
    expect(warnings[0]).toMatch(/Dropped standard_enhancements/);
  });

  // Meta reports Ads Manager's shop setting as native_commerce_experience and
  // answers #3 when an app sends it back (measured 2026-11-19).
  const adsManagerShop = (status: string) => ({
    native_commerce_experience: { product_browsing: { enroll_status: status, action_metadata: { type: "DEFAULT_OFF" } } },
  });

  it("writes Ads Manager's shop opt-out the way an app may send it", () => {
    const { body, warnings } = carryOverFields({ ...base, destination_spec: adsManagerShop("OPT_OUT") } as AdCreative);

    expect(body.destination_spec).toBe(JSON.stringify({ destination_type: "WEBSITE_AND_SHOP_OPT_OUT" }));
    expect(warnings).toEqual([]);
  });

  it("keeps a writable destination_type and leaves Ads Manager's shop setting out", () => {
    const { body } = carryOverFields({
      ...base,
      destination_spec: { destination_type: "WEBSITE_AND_SHOP", ...adsManagerShop("OPT_IN") },
    } as AdCreative);

    expect(body.destination_spec).toBe(JSON.stringify({ destination_type: "WEBSITE_AND_SHOP" }));
  });

  it("never lets Ads Manager's shop opt-out override a writable destination_type", () => {
    const { body, warnings } = carryOverFields({
      ...base,
      destination_spec: { destination_type: "WEBSITE_AND_SHOP", ...adsManagerShop("OPT_OUT") },
    } as AdCreative);

    expect(body.destination_spec).toBe(JSON.stringify({ destination_type: "WEBSITE_AND_SHOP" }));
    expect(warnings).toEqual([]);
  });

  it("says so when Ads Manager's shop setting holds more than the opt-out it writes", () => {
    const { body, warnings } = carryOverFields({
      ...base,
      destination_spec: { native_commerce_experience: { ...adsManagerShop("OPT_OUT").native_commerce_experience, checkout: { enroll_status: "OPT_IN" } } },
    } as AdCreative);

    expect(body.destination_spec).toBe(JSON.stringify({ destination_type: "WEBSITE_AND_SHOP_OPT_OUT" }));
    expect(warnings.join(" ")).toMatch(/checkout/);
  });

  it("drops an Ads Manager shop setting it cannot write, and says so", () => {
    const { body, warnings } = carryOverFields({ ...base, destination_spec: adsManagerShop("OPT_IN") } as AdCreative);

    expect(body.destination_spec).toBeUndefined();
    expect(warnings.join(" ")).toMatch(/native_commerce_experience/);
  });

  it("drops image_background_gen turned on, which Meta takes only with a catalog, and says so", () => {
    const { body, warnings } = carryOverFields({
      ...base,
      degrees_of_freedom_spec: {
        creative_features_spec: {
          image_background_gen: { enroll_status: "OPT_IN" },
          site_extensions: { enroll_status: "OPT_IN" },
        },
      },
    });

    expect(JSON.parse(body.degrees_of_freedom_spec)).toEqual({
      creative_features_spec: { site_extensions: { enroll_status: "OPT_IN" } },
    });
    expect(warnings.join(" ")).toMatch(/image_background_gen.*catalog/);
  });

  it("keeps image_background_gen when it is off", () => {
    const spec = { creative_features_spec: { image_background_gen: { enroll_status: "OPT_OUT" } } };
    const { body, warnings } = carryOverFields({ ...base, degrees_of_freedom_spec: spec });

    expect(JSON.parse(body.degrees_of_freedom_spec)).toEqual(spec);
    expect(warnings).toEqual([]);
  });
});

describe("cleanDegreesOfFreedomSpec", () => {
  it("leaves a spec without deprecated features untouched", () => {
    const spec = { creative_features_spec: { text_optimizations: { enroll_status: "OPT_OUT" } } };
    expect(cleanDegreesOfFreedomSpec(spec)).toEqual({ spec, dropped: [] });
    expect(cleanDegreesOfFreedomSpec(undefined)).toEqual({ dropped: [] });
  });
});

describe("hasFeedContent", () => {
  it("ignores a feed that holds only promotional metadata", () => {
    expect(hasFeedContent({ ...base, asset_feed_spec: { promotional_metadata: {} } })).toBe(false);
    expect(hasFeedContent({ ...base, asset_feed_spec: { bodies: [{ text: "a" }] } })).toBe(true);
    expect(hasFeedContent(base)).toBe(false);
  });
});

describe("withInstagramIdentity", () => {
  it("adds an identity stored beside the spec, and never overrides one inside it", () => {
    expect(withInstagramIdentity({ page_id: "6001" }, { ...base, instagram_user_id: "178" }))
      .toEqual({ page_id: "6001", instagram_user_id: "178" });
    expect(withInstagramIdentity({ page_id: "6001", instagram_user_id: "inside" }, { ...base, instagram_user_id: "178" }))
      .toEqual({ page_id: "6001", instagram_user_id: "inside" });
    expect(withInstagramIdentity({ page_id: "6001" }, base)).toEqual({ page_id: "6001" });
  });
});
