import path from "path";

/**
 * Directory holding downloaded WhatsApp media. TOKYO_MEDIA_DIR overrides the
 * default so tests never touch the production dir. Resolved at call time, so
 * a test can set the env after this module has been imported.
 */
export function mediaDir(): string {
  return process.env.TOKYO_MEDIA_DIR || path.join(__dirname, "..", "whatsapp-media");
}
