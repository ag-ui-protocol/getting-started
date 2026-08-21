export class ADKProtocolError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ADKProtocolError";
  }
}
