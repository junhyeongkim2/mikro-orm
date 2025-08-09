export interface TransactionStatus<T = unknown> {

  /**
   * Returns the underlying transaction object.
   */
  getTransaction(): T | null;

  /**
   * Returns whether this transaction is new (not joining an existing one).
   */
  isNewTransaction(): boolean;

  /**
   * Returns whether this transaction has a savepoint.
   */
  hasSavepoint(): boolean;

  /**
   * Mark this transaction as rollback-only.
   */
  setRollbackOnly(): void;

  /**
   * Returns whether this transaction is marked as rollback-only.
   */
  isRollbackOnly(): boolean;

  /**
   * Returns the suspended resources (previous transaction context).
   */
  getSuspendedResources(): T | null;

  /**
   * Sets the suspended resources.
   */
  setSuspendedResources(resources: T | null): void;

}

export class DefaultTransactionStatus<T = unknown> implements TransactionStatus<T> {

  private rollbackOnly = false;
  private suspendedResources: T | null = null;

  constructor(
    private readonly transaction: T | null,
    private readonly newTransaction: boolean,
    private readonly savepoint = false,
  ) {}

  getTransaction(): T | null {
    return this.transaction;
  }

  isNewTransaction(): boolean {
    return this.newTransaction;
  }

  hasSavepoint(): boolean {
    return this.savepoint;
  }

  setRollbackOnly(): void {
    this.rollbackOnly = true;
  }

  isRollbackOnly(): boolean {
    return this.rollbackOnly;
  }

  getSuspendedResources(): T | null {
    return this.suspendedResources;
  }

  setSuspendedResources(resources: T | null): void {
    this.suspendedResources = resources;
  }

}
