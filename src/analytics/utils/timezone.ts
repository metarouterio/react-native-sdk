   /**
    * Returns the current IANA time zone string for the environment.
    * Falls back to 'UTC' if unavailable.
    * @returns {string} The IANA time zone (e.g., 'America/New_York') or 'UTC'.
    */
export function getTimeZone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return 'UTC';
    }
  }