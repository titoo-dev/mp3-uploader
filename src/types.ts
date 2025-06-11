import { KVNamespace, R2Bucket } from "@cloudflare/workers-types";

export type Bindings = {
  AUDIO_FILES: R2Bucket;
  AUDIO_KV: KVNamespace;
  COVER_FILES: R2Bucket;
  PROJECT_KV: KVNamespace;
    LYRICS_KV: KVNamespace;
};

export type Project = {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  lyricsId?: string;
  audioId: string;
  assetIds?: string[];
};

export type Audio = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
  fileHash: string; // Add hash field to identify duplicates
  metadata?: {
    title?: string;
    artist?: string;
    album?: string;
    year?: string;
    genre?: string[];
    duration?: number;
  };
  coverArt?: {
    id: string;
    format: string;
    size: number;
  };
};

export type Lyrics = {
    id: string;
    createdAt: string;
    updatedAt: string;
    text: string;
    projectId: string;
    lines: {
        id: number;
        text: string;
        timestamp?: number;
    }[];
};
