export interface Env {
	DB: D1Database;
	API_KEY: string;
}

// DB row types (mirror schema.sql)

export interface BookmarkRow {
	id: number;
	url: string;
	title: string;
	note: string | null;
	is_read: number; // 0/1 in SQLite
	created_at: string;
	updated_at: string;
}

export interface TagRow {
	id: number;
	name: string;
	is_approved: number; // 0/1
}

// API response types

export interface BookmarkWithTags extends BookmarkRow {
	tags: string[];
}

// Request body types

export interface CreateBookmarkBody {
	url: string;
}

export interface UpdateBookmarkBody {
	note?: string;
	is_read?: boolean;
	tags?: string[];
}

export interface BatchUpdateItem {
	id: number;
	tags?: string[];
	note?: string;
	is_read?: boolean;
}

export interface BatchUpdateBody {
	updates: BatchUpdateItem[];
}

export interface CreateTagBody {
	name: string;
}

export interface ApproveTagBody {
	name: string;
}

// Shared json helper type
export type JsonFn = (data: unknown, status?: number) => Response;
