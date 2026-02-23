export interface PagingCursors {
  before?: string;
  after?: string;
}

export interface Paging {
  cursors?: PagingCursors;
  next?: string;
  previous?: string;
}

export interface MetaApiResponse<T> {
  data: T[];
  paging?: Paging;
}

export interface MetaApiError {
  message: string;
  type: string;
  code: number;
  error_subcode?: number;
  fbtrace_id?: string;
  error_user_title?: string;
  error_user_msg?: string;
}

export interface MetaApiErrorResponse {
  error: MetaApiError;
}

export interface MetaApiSuccessResponse {
  success: boolean;
}
