import fs from "fs";

/**
 * Who Tokyo works for. Everything personal lives outside the code:
 * OWNER_NAME and OWNER_PROFILE_FILE (a markdown file, see owner-profile.example.md).
 */
export const OWNER_NAME = process.env.OWNER_NAME || "the owner";

const DEFAULT_PROFILE = `## Who is the owner
- A developer and small-business owner who uses Tokyo to run work, life and habits from Telegram and WhatsApp.
- Edit owner-profile.md (OWNER_PROFILE_FILE) to describe your roles, goals, languages, timezone and any routines to respect.`;

function loadProfile(): string {
  const file = process.env.OWNER_PROFILE_FILE;
  if (!file) return DEFAULT_PROFILE;
  try {
    return fs.readFileSync(file, "utf-8").trim() || DEFAULT_PROFILE;
  } catch {
    return DEFAULT_PROFILE;
  }
}

export const OWNER_PROFILE = loadProfile();
