import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Database as ExtDb, User } from "@volute/extension-sdk";
import Database from "libsql";
import { initDb } from "../packages/ext-notes/src/db.js";
import {
  addComment,
  createNote,
  deleteComment,
  deleteNote,
  getComments,
  getNote,
  getReactions,
  listNotes,
  resolveNoteId,
  toggleReaction,
  updateNote,
} from "../packages/ext-notes/src/notes.js";
import { createUser } from "../src/lib/auth.js";

let db: ExtDb;
let userMap: Map<number, User>;
let usernameMap: Map<string, User>;
let testId = 0;

function uniqueName(base: string): string {
  return `${base}-${Date.now()}-${++testId}`;
}

async function getUser(id: number): Promise<User | null> {
  return userMap.get(id) ?? null;
}
async function getUserByUsername(username: string): Promise<User | null> {
  return usernameMap.get(username) ?? null;
}

function registerUser(id: number, username: string): void {
  const user: User = {
    id,
    username,
    role: "admin",
    user_type: "brain",
    display_name: null,
    description: null,
    avatar: null,
  };
  userMap.set(id, user);
  usernameMap.set(username, user);
}

describe("notes", () => {
  let userId: number;
  let username: string;

  beforeEach(async () => {
    db = new Database(":memory:") as unknown as ExtDb;
    initDb(db);
    userMap = new Map();
    usernameMap = new Map();
    const user = await createUser(uniqueName("writer"), "pass123");
    userId = user.id;
    username = user.username;
    registerUser(userId, username);
  });
  afterEach(() => db.close());

  it("createNote creates a note with slug", async () => {
    const note = await createNote(db, getUser, userId, "My First Note", "Hello world");
    assert.equal(note.title, "My First Note");
    assert.equal(note.slug, "my-first-note");
    assert.equal(note.content, "Hello world");
    assert.equal(note.author_username, username);
    assert.equal(note.comment_count, 0);
  });

  it("createNote handles slug collisions", async () => {
    const note1 = await createNote(db, getUser, userId, "Same Title", "Content 1");
    const note2 = await createNote(db, getUser, userId, "Same Title", "Content 2");
    assert.equal(note1.slug, "same-title");
    assert.equal(note2.slug, "same-title-2");
  });

  it("getNote returns note with comments", async () => {
    const created = await createNote(db, getUser, userId, "Test Note", "Content here");
    const note = await getNote(db, getUser, getUserByUsername, username, created.slug);
    assert.ok(note);
    assert.equal(note.title, "Test Note");
    assert.equal(note.content, "Content here");
    assert.deepEqual(note.comments, []);
  });

  it("getNote returns null for non-existent note", async () => {
    const note = await getNote(db, getUser, getUserByUsername, username, "nonexistent");
    assert.equal(note, null);
  });

  it("listNotes returns notes in reverse chronological order", async () => {
    await createNote(db, getUser, userId, "First", "A");
    await createNote(db, getUser, userId, "Second", "B");
    const all = await listNotes(db, getUser, getUserByUsername);
    assert.equal(all.length, 2);
    assert.equal(all[0].title, "Second");
    assert.equal(all[1].title, "First");
  });

  it("listNotes filters by author", async () => {
    const other = await createUser(uniqueName("other"), "pass123");
    registerUser(other.id, other.username);
    await createNote(db, getUser, userId, "Mine", "A");
    await createNote(db, getUser, other.id, "Theirs", "B");

    const mine = await listNotes(db, getUser, getUserByUsername, { authorUsername: username });
    assert.equal(mine.length, 1);
    assert.equal(mine[0].title, "Mine");
  });

  it("deleteNote removes note", async () => {
    const note = await createNote(db, getUser, userId, "To Delete", "Bye");
    const deleted = await deleteNote(db, getUserByUsername, username, note.slug, userId);
    assert.ok(deleted);
    const check = await getNote(db, getUser, getUserByUsername, username, note.slug);
    assert.equal(check, null);
  });

  it("deleteNote rejects non-author", async () => {
    const other = await createUser(uniqueName("other2"), "pass123");
    registerUser(other.id, other.username);
    const note = await createNote(db, getUser, userId, "Protected", "No");
    const deleted = await deleteNote(db, getUserByUsername, username, note.slug, other.id);
    assert.equal(deleted, false);
  });

  it("addComment and getComments work", async () => {
    const note = await createNote(db, getUser, userId, "Commentable", "...");
    const comment = await addComment(db, getUser, note.id, userId, "Great note!");
    assert.equal(comment.content, "Great note!");
    assert.equal(comment.author_username, username);

    const comments = await getComments(db, getUser, note.id);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].content, "Great note!");
  });

  it("deleteComment removes own comment", async () => {
    const note = await createNote(db, getUser, userId, "Note", "...");
    const comment = await addComment(db, getUser, note.id, userId, "My comment");
    const deleted = await deleteComment(db, comment.id, userId);
    assert.ok(deleted);
    const remaining = await getComments(db, getUser, note.id);
    assert.equal(remaining.length, 0);
  });

  it("deleteComment rejects non-author", async () => {
    const other = await createUser(uniqueName("other3"), "pass123");
    registerUser(other.id, other.username);
    const note = await createNote(db, getUser, userId, "Note2", "...");
    const comment = await addComment(db, getUser, note.id, userId, "My comment");
    const deleted = await deleteComment(db, comment.id, other.id);
    assert.equal(deleted, false);
  });

  it("listNotes includes comment counts", async () => {
    const note = await createNote(db, getUser, userId, "With Comments", "...");
    await addComment(db, getUser, note.id, userId, "Comment 1");
    await addComment(db, getUser, note.id, userId, "Comment 2");
    const all = await listNotes(db, getUser, getUserByUsername);
    assert.equal(all[0].comment_count, 2);
  });

  it("listNotes respects limit and offset", async () => {
    await createNote(db, getUser, userId, "A", "1");
    await createNote(db, getUser, userId, "B", "2");
    await createNote(db, getUser, userId, "C", "3");
    const page1 = await listNotes(db, getUser, getUserByUsername, { limit: 2 });
    assert.equal(page1.length, 2);
    assert.equal(page1[0].title, "C");
    const page2 = await listNotes(db, getUser, getUserByUsername, { limit: 2, offset: 2 });
    assert.equal(page2.length, 1);
    assert.equal(page2[0].title, "A");
  });

  it("getNote returns null for non-existent author", async () => {
    await createNote(db, getUser, userId, "Exists", "...");
    const note = await getNote(db, getUser, getUserByUsername, "nonexistent-user", "exists");
    assert.equal(note, null);
  });

  it("createNote handles empty title with untitled slug", async () => {
    const note = await createNote(db, getUser, userId, "!!!", "special chars only");
    assert.equal(note.slug, "untitled");
  });

  it("updateNote updates title only", async () => {
    const note = await createNote(db, getUser, userId, "Original Title", "Original Content");
    const updated = await updateNote(db, getUser, getUserByUsername, username, note.slug, {
      title: "New Title",
    });
    assert.ok(updated);
    assert.equal(updated!.title, "New Title");
    assert.equal(updated!.content, "Original Content");
  });

  it("updateNote updates content only", async () => {
    const note = await createNote(db, getUser, userId, "Keep Title", "Old Content");
    const updated = await updateNote(db, getUser, getUserByUsername, username, note.slug, {
      content: "New Content",
    });
    assert.ok(updated);
    assert.equal(updated!.title, "Keep Title");
    assert.equal(updated!.content, "New Content");
  });

  it("updateNote updates both title and content", async () => {
    const note = await createNote(db, getUser, userId, "Both", "Both");
    const updated = await updateNote(db, getUser, getUserByUsername, username, note.slug, {
      title: "New Both",
      content: "New Both Content",
    });
    assert.ok(updated);
    assert.equal(updated!.title, "New Both");
    assert.equal(updated!.content, "New Both Content");
  });

  it("updateNote returns null for nonexistent note", async () => {
    const result = await updateNote(db, getUser, getUserByUsername, username, "no-such-note", {
      title: "x",
    });
    assert.equal(result, null);
  });

  it("updateNote returns null for nonexistent author", async () => {
    const result = await updateNote(db, getUser, getUserByUsername, "nobody", "whatever", {
      title: "x",
    });
    assert.equal(result, null);
  });
});

describe("note reactions", () => {
  let userId: number;
  let otherUserId: number;
  let username: string;
  let otherUsername: string;

  beforeEach(async () => {
    db = new Database(":memory:") as unknown as ExtDb;
    initDb(db);
    userMap = new Map();
    usernameMap = new Map();
    const user = await createUser(uniqueName("reactor"), "pass123");
    userId = user.id;
    username = user.username;
    registerUser(userId, username);
    const other = await createUser(uniqueName("reactor2"), "pass123");
    otherUserId = other.id;
    otherUsername = other.username;
    registerUser(otherUserId, otherUsername);
  });
  afterEach(() => db.close());

  it("toggleReaction adds a reaction", async () => {
    const note = await createNote(db, getUser, userId, "React to me", "...");
    const result = toggleReaction(db, note.id, userId, "❤️");
    assert.equal(result.added, true);

    const reactions = await getReactions(db, getUser, note.id);
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0].emoji, "❤️");
    assert.equal(reactions[0].count, 1);
    assert.deepEqual(reactions[0].usernames, [username]);
  });

  it("toggleReaction removes on second call", async () => {
    const note = await createNote(db, getUser, userId, "Toggle me", "...");
    toggleReaction(db, note.id, userId, "🔥");
    const result = toggleReaction(db, note.id, userId, "🔥");
    assert.equal(result.added, false);

    const reactions = await getReactions(db, getUser, note.id);
    assert.equal(reactions.length, 0);
  });

  it("multiple users can react with same emoji", async () => {
    const note = await createNote(db, getUser, userId, "Popular", "...");
    toggleReaction(db, note.id, userId, "👍");
    toggleReaction(db, note.id, otherUserId, "👍");

    const reactions = await getReactions(db, getUser, note.id);
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0].count, 2);
    assert.ok(reactions[0].usernames.includes(username));
    assert.ok(reactions[0].usernames.includes(otherUsername));
  });

  it("multiple emojis on same note", async () => {
    const note = await createNote(db, getUser, userId, "Multi react", "...");
    toggleReaction(db, note.id, userId, "❤️");
    toggleReaction(db, note.id, userId, "🤔");

    const reactions = await getReactions(db, getUser, note.id);
    assert.equal(reactions.length, 2);
  });

  it("listNotes includes reaction summary", async () => {
    const note = await createNote(db, getUser, userId, "With Reactions", "...");
    toggleReaction(db, note.id, userId, "❤️");
    toggleReaction(db, note.id, otherUserId, "❤️");
    toggleReaction(db, note.id, userId, "🌱");

    const all = await listNotes(db, getUser, getUserByUsername);
    assert.ok(all[0].reactions);
    assert.ok(all[0].reactions!.length > 0);
    const heart = all[0].reactions!.find((r) => r.emoji === "❤️");
    assert.ok(heart);
    assert.equal(heart!.count, 2);
  });

  it("getNote includes full reactions", async () => {
    const note = await createNote(db, getUser, userId, "Full reactions", "...");
    toggleReaction(db, note.id, userId, "🌊");

    const fetched = await getNote(db, getUser, getUserByUsername, username, note.slug);
    assert.ok(fetched);
    assert.ok(fetched.reactions);
    assert.equal(fetched.reactions!.length, 1);
    assert.equal(fetched.reactions![0].emoji, "🌊");
    assert.deepEqual(fetched.reactions![0].usernames, [username]);
  });

  it("deleting a note cascades reactions", async () => {
    const note = await createNote(db, getUser, userId, "Will delete", "...");
    toggleReaction(db, note.id, userId, "❤️");
    await deleteNote(db, getUserByUsername, username, note.slug, userId);

    const reactions = await getReactions(db, getUser, note.id);
    assert.equal(reactions.length, 0);
  });
});

describe("note replies", () => {
  let userId: number;
  let username: string;

  beforeEach(async () => {
    db = new Database(":memory:") as unknown as ExtDb;
    initDb(db);
    userMap = new Map();
    usernameMap = new Map();
    const user = await createUser(uniqueName("replier"), "pass123");
    userId = user.id;
    username = user.username;
    registerUser(userId, username);
  });
  afterEach(() => db.close());

  it("createNote with replyToId links to parent", async () => {
    const parent = await createNote(db, getUser, userId, "Original", "The original note");
    const reply = await createNote(db, getUser, userId, "My Reply", "Replying here", parent.id);
    assert.ok(reply.id !== parent.id);

    const fetched = await getNote(db, getUser, getUserByUsername, username, reply.slug);
    assert.ok(fetched);
    assert.ok(fetched.reply_to);
    assert.equal(fetched.reply_to!.slug, "original");
    assert.equal(fetched.reply_to!.title, "Original");
  });

  it("getNote includes replies list on parent", async () => {
    const parent = await createNote(db, getUser, userId, "Parent Note", "...");
    await createNote(db, getUser, userId, "Reply One", "First reply", parent.id);
    await createNote(db, getUser, userId, "Reply Two", "Second reply", parent.id);

    const fetched = await getNote(db, getUser, getUserByUsername, username, parent.slug);
    assert.ok(fetched);
    assert.ok(fetched.replies);
    assert.equal(fetched.replies.length, 2);
    assert.equal(fetched.replies[0].title, "Reply One");
    assert.equal(fetched.replies[1].title, "Reply Two");
  });

  it("listNotes includes reply_to summary", async () => {
    const parent = await createNote(db, getUser, userId, "Listed Parent", "...");
    await createNote(db, getUser, userId, "Listed Reply", "...", parent.id);

    const all = await listNotes(db, getUser, getUserByUsername);
    const reply = all.find((n) => n.title === "Listed Reply");
    assert.ok(reply);
    assert.ok(reply!.reply_to);
    assert.equal(reply!.reply_to!.slug, "listed-parent");
  });

  it("resolveNoteId resolves author/slug to id", async () => {
    const note = await createNote(db, getUser, userId, "Resolvable", "...");
    const id = await resolveNoteId(db, getUserByUsername, `${username}/${note.slug}`);
    assert.equal(id, note.id);
  });

  it("resolveNoteId returns null for nonexistent", async () => {
    const id = await resolveNoteId(db, getUserByUsername, "nobody/nothing");
    assert.equal(id, null);
  });

  it("deleting parent sets reply_to to null", async () => {
    const parent = await createNote(db, getUser, userId, "To be deleted", "...");
    const reply = await createNote(db, getUser, userId, "Orphan reply", "...", parent.id);
    await deleteNote(db, getUserByUsername, username, parent.slug, userId);

    const fetched = await getNote(db, getUser, getUserByUsername, username, reply.slug);
    assert.ok(fetched);
    assert.equal(fetched.reply_to, null);
  });
});
