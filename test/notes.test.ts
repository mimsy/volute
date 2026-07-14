import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Database as ExtDb, ExtensionContext, User } from "@volute/extensions";
import Database from "libsql";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { createCommands } from "../packages/extensions/notes/src/commands.js";
import { initDb } from "../packages/extensions/notes/src/db.js";
import {
  addComment,
  countNotes,
  createNote,
  deleteComment,
  deleteNote,
  findNote,
  getComments,
  getNote,
  getReactions,
  listNotes,
  resolveNoteId,
  toggleReaction,
  updateNote,
} from "../packages/extensions/notes/src/notes.js";

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
    user_type: "human",
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
    const deleted = await deleteComment(db, comment.id, { id: userId, role: "user" });
    assert.ok(deleted);
    const remaining = await getComments(db, getUser, note.id);
    assert.equal(remaining.length, 0);
  });

  it("deleteComment rejects an unrelated non-author", async () => {
    const noteOwner = await createUser(uniqueName("owner3"), "pass123");
    registerUser(noteOwner.id, noteOwner.username);
    const commenter = await createUser(uniqueName("commenter3"), "pass123");
    registerUser(commenter.id, commenter.username);
    const stranger = await createUser(uniqueName("stranger3"), "pass123");
    registerUser(stranger.id, stranger.username);

    const note = await createNote(db, getUser, noteOwner.id, "Note2", "...");
    const comment = await addComment(db, getUser, note.id, commenter.id, "A comment");
    // A stranger (not comment author, not note author, not admin) cannot delete it.
    const deleted = await deleteComment(db, comment.id, { id: stranger.id, role: "user" });
    assert.equal(deleted, false);
    assert.equal((await getComments(db, getUser, note.id)).length, 1);
  });

  it("deleteComment allows the note author to moderate", async () => {
    const noteOwner = await createUser(uniqueName("owner4"), "pass123");
    registerUser(noteOwner.id, noteOwner.username);
    const commenter = await createUser(uniqueName("commenter4"), "pass123");
    registerUser(commenter.id, commenter.username);

    const note = await createNote(db, getUser, noteOwner.id, "Note3", "...");
    const comment = await addComment(db, getUser, note.id, commenter.id, "spam");
    const deleted = await deleteComment(db, comment.id, { id: noteOwner.id, role: "user" });
    assert.ok(deleted);
  });

  it("deleteComment allows an admin to moderate any comment", async () => {
    const noteOwner = await createUser(uniqueName("owner5"), "pass123");
    registerUser(noteOwner.id, noteOwner.username);
    const commenter = await createUser(uniqueName("commenter5"), "pass123");
    registerUser(commenter.id, commenter.username);

    const note = await createNote(db, getUser, noteOwner.id, "Note4", "...");
    const comment = await addComment(db, getUser, note.id, commenter.id, "spam");
    const deleted = await deleteComment(db, comment.id, { id: 99999, role: "admin" });
    assert.ok(deleted);
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

  it("resolveNoteId rejects refs with extra slashes", async () => {
    const note = await createNote(db, getUser, userId, "Slashy", "...");
    const id = await resolveNoteId(db, getUserByUsername, `${username}/${note.slug}/extra`);
    assert.equal(id, null);
  });

  it("slugify drops apostrophes rather than turning them into dashes", async () => {
    const note = await createNote(db, getUser, userId, "The Skeleton's Calendar", "...");
    assert.equal(note.slug, "the-skeletons-calendar");
  });

  it("findNote resolves an exact slug", async () => {
    const note = await createNote(db, getUser, userId, "Exact Match", "...");
    const found = await findNote(db, getUserByUsername, username, note.slug);
    assert.ok("authorId" in found);
    assert.equal(found.slug, note.slug);
  });

  it("findNote fuzzily resolves a punctuation near-miss", async () => {
    const note = await createNote(db, getUser, userId, "The Skeleton's Calendar", "...");
    // Someone hand-types the possessive as "-s-".
    const found = await findNote(db, getUserByUsername, username, "the-skeleton-s-calendar");
    assert.ok("authorId" in found);
    assert.equal(found.slug, note.slug);
  });

  it("findNote returns suggestions on a miss", async () => {
    await createNote(db, getUser, userId, "Something Real", "...");
    const found = await findNote(db, getUserByUsername, username, "totally-unrelated");
    assert.ok("suggestions" in found);
    assert.ok(found.suggestions.length > 0);
    assert.match(found.suggestions[0], new RegExp(`^${username}/`));
  });

  it("createNote survives a slug already taken (collision)", async () => {
    const first = await createNote(db, getUser, userId, "Dup Title", "one");
    const second = await createNote(db, getUser, userId, "Dup Title", "two");
    assert.equal(first.slug, "dup-title");
    assert.notEqual(second.slug, first.slug);
  });

  it("countNotes counts all matching notes independent of limit", async () => {
    for (let i = 0; i < 4; i++) await createNote(db, getUser, userId, `Counted ${i}`, "...");
    const total = await countNotes(db, getUserByUsername, { authorUsername: username });
    assert.equal(total, 4);
    const page = await listNotes(db, getUser, getUserByUsername, { limit: 2 });
    assert.equal(page.length, 2);
  });

  it("listNotes and countNotes honor --since", async () => {
    await createNote(db, getUser, userId, "Old One", "...");
    // Everything is created "now"; a future cutoff excludes all.
    const future = new Date(Date.now() + 60_000).toISOString().replace("T", " ").slice(0, 19);
    const recent = await listNotes(db, getUser, getUserByUsername, { since: future });
    assert.equal(recent.length, 0);
    const count = await countNotes(db, getUserByUsername, { since: future });
    assert.equal(count, 0);
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

describe("notes commands stdin", () => {
  let userId: number;
  let username: string;
  let announced: string[];
  let notices: { mind: string; text: string }[];
  let activities: { type: string; metadata?: Record<string, unknown> }[];
  const commands = createCommands();

  function makeCtx(
    overrides: Partial<ExtensionContext & { mindName?: string; stdin?: string }> = {},
  ) {
    return {
      db,
      authMiddleware: (() => {}) as unknown as ExtensionContext["authMiddleware"],
      resolveUser: () => null,
      getUser,
      getUserByUsername,
      publishActivity: (e: { type: string; metadata?: Record<string, unknown> }) => {
        activities.push(e);
      },
      getMindDir: () => null,
      getSystemsConfig: () => null,
      announceToSystem: async (text: string) => {
        announced.push(text);
      },
      recordNotice: async (mind: string, text: string) => {
        notices.push({ mind, text });
      },
      dataDir: "/tmp",
      mindName: username,
      ...overrides,
    };
  }

  beforeEach(async () => {
    db = new Database(":memory:") as unknown as ExtDb;
    initDb(db);
    userMap = new Map();
    usernameMap = new Map();
    announced = [];
    notices = [];
    activities = [];
    const user = await createUser(uniqueName("cmduser"), "pass123");
    userId = user.id;
    username = user.username;
    registerUser(userId, username);
  });
  afterEach(() => db.close());

  it("write uses stdin when content arg is missing", async () => {
    const result = await commands.write.handler(
      { args: { title: "Stdin Title" }, flags: {}, rest: [] },
      makeCtx({ stdin: "from stdin" }),
    );
    assert.ok("output" in result);
    assert.match(result.output, /Published:/);

    const notes = await listNotes(db, getUser, getUserByUsername);
    assert.equal(notes[0].title, "Stdin Title");
    const note = await getNote(db, getUser, getUserByUsername, username, notes[0].slug);
    assert.equal(note!.content, "from stdin");

    assert.equal(activities.length, 1);
    assert.equal(activities[0].type, "note_created");
    assert.equal(activities[0].metadata?.url, `/minds/${username}/notes/${notes[0].slug}`);
  });

  it("write prefers arg over stdin", async () => {
    const result = await commands.write.handler(
      { args: { title: "Title", content: "from arg" }, flags: {}, rest: [] },
      makeCtx({ stdin: "from stdin" }),
    );
    assert.ok("output" in result);

    const notes = await listNotes(db, getUser, getUserByUsername);
    const note = await getNote(db, getUser, getUserByUsername, username, notes[0].slug);
    assert.equal(note!.content, "from arg");
  });

  it("write errors when no content arg and no stdin", async () => {
    const result = await commands.write.handler(
      { args: { title: "Title Only" }, flags: {}, rest: [] },
      makeCtx(),
    );
    assert.ok("error" in result);
  });

  it("comment uses stdin when content arg is missing", async () => {
    const note = await createNote(db, getUser, userId, "Commentable", "...");
    const ref = `${username}/${note.slug}`;
    const result = await commands.comment.handler(
      { args: { ref }, flags: {}, rest: [] },
      makeCtx({ stdin: "stdin comment" }),
    );
    assert.ok("output" in result);
    assert.equal(result.output, "Comment added.");

    const comments = await getComments(db, getUser, note.id);
    assert.equal(comments[0].content, "stdin comment");
  });

  it("comment prefers arg over stdin", async () => {
    const note = await createNote(db, getUser, userId, "Commentable2", "...");
    const ref = `${username}/${note.slug}`;
    const result = await commands.comment.handler(
      { args: { ref, content: "arg comment" }, flags: {}, rest: [] },
      makeCtx({ stdin: "stdin comment" }),
    );
    assert.ok("output" in result);

    const comments = await getComments(db, getUser, note.id);
    assert.equal(comments[0].content, "arg comment");
  });

  it("comment errors when no content arg and no stdin", async () => {
    const note = await createNote(db, getUser, userId, "Commentable3", "...");
    const ref = `${username}/${note.slug}`;
    const result = await commands.comment.handler(
      { args: { ref }, flags: {}, rest: [] },
      makeCtx(),
    );
    assert.ok("error" in result);
  });

  it("write announces the note to #system", async () => {
    await commands.write.handler(
      { args: { title: "Announce Me", content: "hi" }, flags: {}, rest: [] },
      makeCtx(),
    );
    assert.equal(announced.length, 1);
    assert.match(announced[0], /published a note/);
    assert.match(announced[0], /Announce Me/);
  });

  it("comment records a notice for the note author (not self)", async () => {
    const author = await createUser(uniqueName("author"), "pass123");
    registerUser(author.id, author.username);
    const note = await createNote(db, getUser, author.id, "Their Note", "...");
    const ref = `${author.username}/${note.slug}`;

    // A different mind comments → author is notified.
    await commands.comment.handler(
      { args: { ref, content: "nice one" }, flags: {}, rest: [] },
      makeCtx({ mindName: username }),
    );
    assert.equal(notices.length, 1);
    assert.equal(notices[0].mind, author.username);
    assert.match(notices[0].text, /commented on your note/);

    // The author commenting on their own note → no self-notice.
    notices = [];
    await commands.comment.handler(
      { args: { ref, content: "reply to self" }, flags: {}, rest: [] },
      makeCtx({ mindName: author.username }),
    );
    assert.equal(notices.length, 0);
  });

  it("react notices on add but not on toggle-off", async () => {
    const author = await createUser(uniqueName("rauthor"), "pass123");
    registerUser(author.id, author.username);
    const note = await createNote(db, getUser, author.id, "React Note", "...");
    const ref = `${author.username}/${note.slug}`;

    await commands.react.handler(
      { args: { ref, emoji: "🌱" }, flags: {}, rest: [] },
      makeCtx({ mindName: username }),
    );
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /reacted 🌱/);

    // Toggling the same reaction off should NOT notify.
    notices = [];
    await commands.react.handler(
      { args: { ref, emoji: "🌱" }, flags: {}, rest: [] },
      makeCtx({ mindName: username }),
    );
    assert.equal(notices.length, 0);
  });

  it("list shows a footer when more notes exist than the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await createNote(db, getUser, userId, `Note ${i}`, "...");
    }
    const result = await commands.list.handler(
      { args: {}, flags: { limit: 2 }, rest: [] },
      makeCtx(),
    );
    assert.ok("output" in result);
    assert.match(result.output, /of 5/);
  });

  it("list renders comment and reaction markers", async () => {
    const note = await createNote(db, getUser, userId, "Marked", "...");
    await addComment(db, getUser, note.id, userId, "c1");
    toggleReaction(db, note.id, userId, "🌱");
    const result = await commands.list.handler({ args: {}, flags: {}, rest: [] }, makeCtx());
    assert.ok("output" in result);
    assert.match(result.output, /💬1/);
    assert.match(result.output, /🌱1/);
  });

  it("read shows reactors, replies, and edited marker", async () => {
    const note = await createNote(db, getUser, userId, "Rich Note", "body");
    toggleReaction(db, note.id, userId, "✨");
    await createNote(db, getUser, userId, "A Reply", "...", note.id);
    await updateNote(db, getUser, getUserByUsername, username, note.slug, {
      content: "edited body",
    });
    // Force updated_at strictly after created_at so the "edited" marker is deterministic
    // (SQLite datetime('now') is second-granular, so a fast update can tie the timestamp).
    db.prepare("UPDATE notes SET updated_at = datetime(created_at, '+1 minute') WHERE id = ?").run(
      note.id,
    );

    const result = await commands.read.handler(
      { args: { ref: `${username}/${note.slug}` }, flags: {}, rest: [] },
      makeCtx(),
    );
    assert.ok("output" in result);
    assert.match(result.output, new RegExp(`✨ ${username}`));
    assert.match(result.output, /Replies \(1\)/);
    assert.match(result.output, /edited/);
  });

  it("edit updates own note and rejects others", async () => {
    const note = await createNote(db, getUser, userId, "Editable", "before");
    const ok = await commands.edit.handler(
      { args: { ref: `${username}/${note.slug}`, content: "after" }, flags: {}, rest: [] },
      makeCtx(),
    );
    assert.ok("output" in ok);
    const reloaded = await getNote(db, getUser, getUserByUsername, username, note.slug);
    assert.equal(reloaded!.content, "after");

    const other = await createUser(uniqueName("editor"), "pass123");
    registerUser(other.id, other.username);
    const rejected = await commands.edit.handler(
      { args: { ref: `${username}/${note.slug}`, content: "hijack" }, flags: {}, rest: [] },
      makeCtx({ mindName: other.username }),
    );
    assert.ok("error" in rejected);
  });

  it("read suggests the closest slug on a near-miss", async () => {
    await createNote(db, getUser, userId, "The Skeleton's Calendar", "...");
    const result = await commands.read.handler(
      { args: { ref: `${username}/the-skeletons-calendar-typo` }, flags: {}, rest: [] },
      makeCtx(),
    );
    // Not an exact/fuzzy hit → error with a suggestion or list hint.
    assert.ok("error" in result);
    assert.match(result.error, /Did you mean|notes list/);
  });
});
