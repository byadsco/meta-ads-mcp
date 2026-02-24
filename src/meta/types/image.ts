export interface AdImage {
  hash: string;
  url: string;
  url_128?: string;
  name?: string;
  width?: number;
  height?: number;
  created_time?: string;
  status?: string;
  permalink_url?: string;
}

export const IMAGE_DEFAULT_FIELDS = [
  "hash",
  "url",
  "url_128",
  "name",
  "width",
  "height",
  "created_time",
  "status",
  "permalink_url",
] as const;
