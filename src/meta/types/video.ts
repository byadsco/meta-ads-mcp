export interface AdVideo {
  id: string;
  title?: string;
  description?: string;
  source?: string;
  picture?: string;
  thumbnails?: { data: Array<{ uri: string; width: number; height: number }> };
  length?: number;
  created_time?: string;
  updated_time?: string;
  status?: { video_status: string };
}

export const VIDEO_DEFAULT_FIELDS = [
  "id",
  "title",
  "description",
  "source",
  "picture",
  "length",
  "created_time",
  "updated_time",
  "status",
] as const;

export const VIDEO_DETAIL_FIELDS = [
  "id",
  "title",
  "description",
  "source",
  "picture",
  "thumbnails",
  "length",
  "created_time",
  "updated_time",
  "status",
] as const;
