class SessionClosingError extends Error {
  public readonly code = "session_closing";

  public constructor() {
    super("session_closing");
    this.name = "SessionClosingError";
  }
}

export { SessionClosingError };
