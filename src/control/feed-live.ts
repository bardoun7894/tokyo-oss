import db from "../db";
import { FeedStore } from "./feed";

// The one feed store of the running Tokyo, shared by the bot's send hook and the Control API.
let store: FeedStore | null = null;

export function liveFeed(): FeedStore {
  return (store ??= new FeedStore(db as any));
}
