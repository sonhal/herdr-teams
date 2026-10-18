export class HerdrApiError extends Error {
  override readonly name = 'HerdrApiError';
  readonly exitCode = 1;
  constructor(
    readonly code: string,
    message: string,
    readonly requestId: string,
  ) {
    super(message);
  }
}

export class HerdrUsageError extends Error {
  override readonly name = 'HerdrUsageError';
  readonly exitCode = 2;
  constructor(readonly stderr: string) {
    super(stderr.trim() || 'herdr rejected the command syntax');
  }
}

export class HerdrProtocolError extends Error {
  override readonly name = 'HerdrProtocolError';
}

export class HerdrProcessError extends Error {
  override readonly name = 'HerdrProcessError';
  constructor(
    message: string,
    readonly exitCode: number | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
