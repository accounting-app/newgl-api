export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400);
    this.name = "ValidationError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409);
    this.name = "ConflictError";
  }
}

/**
 * Raised when something would change or remove a transaction that has
 * already been reconciled. Like QBO this is a warning, not a lock: the
 * caller may confirm (X-Confirm-Reconciled: true) and proceed -- the change
 * then shows up on the Reconciliation Discrepancy report.
 */
export class ReconciledTransactionError extends ConflictError {
  readonly code = "RECONCILED_TRANSACTION";
  constructor(message: string) {
    super(message);
    this.name = "ReconciledTransactionError";
  }
}
