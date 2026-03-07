// Cursor-based pagination types

export type CursorParams = {
  /** Message ID to fetch messages before (for scrolling up). Omit for latest. */
  before?: number;
  /** Maximum number of items to return. Default 50, max 100. */
  limit?: number;
};

export type CursorResponse<T> = {
  items: T[];
  /** Whether there are more items before the oldest returned item. */
  hasMore: boolean;
};
