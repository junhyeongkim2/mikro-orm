import type { EntityManager } from '../EntityManager';
import type { Platform } from '../platforms/Platform';
import type { Connection } from '../connections/Connection';
import { type TransactionOptions, TransactionPropagation } from '../enums';
import { type FlushEventArgs, TransactionEventBroadcaster } from '../events';
import { TransactionContext } from '../utils/TransactionContext';
import { ChangeSetType } from '../unit-of-work';
import { PlatformAdapter } from './PlatformAdapter';

/**
 * Manages transaction lifecycle and propagation for EntityManager.
 * This class encapsulates the complex logic of handling different transaction propagation types.
 */
export class TransactionManager {

  private readonly platformAdapter: PlatformAdapter;

  constructor(private readonly em: EntityManager) {
    this.platformAdapter = new PlatformAdapter(em.getPlatform());
  }

  /**
   * Main entry point for handling transactional operations with propagation support.
   */
  async handle<T>(
    cb: (em: EntityManager) => T | Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const em = this.em.getContext(false) as EntityManager;

    // Handle disabled transactions
    if (this.em.isTransactionsDisabled || em.isTransactionsDisabled) {
      // If transactions are disabled, just run the callback directly
      return cb(em);
    }

    // If no explicit propagation is set, use the original implementation
    if (!options.propagation) {
      return this.executeDefaultTransaction(em, cb, options);
    }

    // Set the context to the current transaction context if not already set
    options.ctx ??= em.getTransactionContext();
    const hasExistingTransaction = !!em.getTransactionContext();
    const propagation = this.resolvePropagation(options, hasExistingTransaction);

    // If propagation is undefined and MongoDB doesn't support savepoints,
    // use the original transactional flow to preserve MongoDB's error handling
    if (propagation === undefined) {
      return this.executeDefaultTransaction(em, cb, options);
    }

    return this.executeWithPropagation(propagation, em, cb, options);
  }

  /**
   * Resolves the transaction propagation type based on options and context.
   */
  private resolvePropagation(
    options: TransactionOptions,
    hasExistingTransaction: boolean,
  ): TransactionPropagation | undefined {
    return this.platformAdapter.resolvePropagation(
      options.propagation,
      hasExistingTransaction,
      options,
    );
  }

  /**
   * Executes the callback with the specified propagation type.
   */
  private async executeWithPropagation<T>(
    propagation: TransactionPropagation,
    em: EntityManager,
    cb: (em: EntityManager) => T | Promise<T>,
    options: TransactionOptions,
  ): Promise<T> {
    const hasExistingTransaction = !!em.getTransactionContext();

    switch (propagation) {
      case TransactionPropagation.NOT_SUPPORTED:
        return this.executeWithoutTransaction(em, cb, options);

      case TransactionPropagation.REQUIRES_NEW:
        return this.executeWithNewTransaction(em, cb, options, hasExistingTransaction);

      case TransactionPropagation.REQUIRED:
        if (hasExistingTransaction) {
          return this.joinExistingTransaction(em, cb, options);
        }
        return this.createNewTransaction(em, cb, options);

      case TransactionPropagation.NESTED:
        if (hasExistingTransaction) {
          return this.executeNestedTransaction(em, cb, options);
        }
        return this.createNewTransaction(em, cb, options);

      default:
        throw new Error(`Unsupported transaction propagation type: ${propagation}`);
    }
  }

  /**
   * Executes a transaction with default behavior (backward compatibility).
   * Used when no explicit propagation is specified.
   */
  private async executeDefaultTransaction<T>(
    em: EntityManager,
    cb: (em: EntityManager) => T | Promise<T>,
    options: TransactionOptions,
  ): Promise<T> {
    const fork = this.createFork(em, options);
    options.ctx ??= em.getTransactionContext();
    const propagateToUpperContext = this.shouldPropagateToUpperContext(em);

    return TransactionContext.create(fork, () =>
      this.processTransactionCallback(fork, cb, options, propagateToUpperContext, em),
    );
  }

  /**
   * Processes transaction callback with lifecycle management.
   */
  private async processTransactionCallback<T>(
    fork: EntityManager,
    cb: (em: EntityManager) => T | Promise<T>,
    options: TransactionOptions,
    propagateToUpperContext: boolean,
    parentEm: EntityManager,
  ): Promise<T> {
    const eventBroadcaster = new TransactionEventBroadcaster(
      fork,
      undefined,
      { topLevelTransaction: !options.ctx },
    );

    return fork.getConnection().transactional(async trx => {
      fork.setTransactionContext(trx);
      return this.executeTransactionFlow(fork, cb, propagateToUpperContext, parentEm);
    }, { ...options, eventBroadcaster });
  }

  /**
   * Suspends the current transaction and returns the suspended resources.
   */
  private suspendTransaction(em: EntityManager): unknown {
    const suspended = em.getTransactionContext();
    em.setTransactionContext(null!);
    return suspended;
  }

  /**
   * Resumes a previously suspended transaction.
   */
  private resumeTransaction(em: EntityManager, suspended: unknown): void {
    if (suspended !== null) {
      em.setTransactionContext(suspended!);
    }
  }

  /**
   * Executes operation without transaction context (NOT_SUPPORTED).
   */
  private async executeWithoutTransaction<T>(
    em: EntityManager,
    cb: (em: EntityManager) => T | Promise<T>,
    options: TransactionOptions,
  ): Promise<T> {
    const suspended = this.suspendTransaction(em);
    const fork = this.createFork(em, { ...options, disableTransactions: true } as TransactionOptions);
    const propagateToUpperContext = this.shouldPropagateToUpperContext(em);

    try {
      return await this.executeTransactionFlow(fork, cb, propagateToUpperContext, em);
    } finally {
      this.resumeTransaction(em, suspended);
    }
  }

  /**
   * Creates new independent transaction (REQUIRES_NEW).
   */
  private async executeWithNewTransaction<T>(
    em: EntityManager,
    cb: (em: EntityManager) => T | Promise<T>,
    options: TransactionOptions,
    hasExistingTransaction: boolean,
  ): Promise<T> {
    const fork = this.createFork(em, options);
    const newOptions = this.prepareNewTransactionOptions(em, options, hasExistingTransaction);
    const suspended = newOptions.suspended;

    try {
      return await this.processTransaction(em, fork, cb, newOptions);
    } finally {
      if (suspended !== null) {
        this.resumeTransaction(em, suspended);
      }
    }
  }

  /**
   * Prepares transaction options with suspension handling.
   */
  private prepareNewTransactionOptions(
    em: EntityManager,
    options: TransactionOptions,
    hasExistingTransaction: boolean,
  ): TransactionOptions & { suspended: unknown } {
    const newOptions = { ...options, suspended: null as unknown };

    // SQLite with existing transaction: pass context for fallback
    if (!this.platformAdapter.supportsIndependentTransactions() && hasExistingTransaction) {
      newOptions.ctx = em.getTransactionContext();
      return newOptions;
    }

    // True independent transaction: suspend existing if present
    if (hasExistingTransaction) {
      newOptions.suspended = this.suspendTransaction(em);
    }
    newOptions.ctx = undefined;
    return newOptions;
  }

  /**
   * Joins existing transaction context (REQUIRED).
   */
  private async joinExistingTransaction<T>(
    em: EntityManager,
    cb: (em: EntityManager) => T | Promise<T>,
    options: TransactionOptions,
  ): Promise<T> {
    const fork = this.createFork(em, options);

    // Reuse existing transaction context
    const existingContext = em.getTransactionContext();
    fork.setTransactionContext(existingContext!);

    const propagateToUpperContext = this.shouldPropagateToUpperContext(em);

    return TransactionContext.create(fork, () =>
      this.executeTransactionFlow(fork, cb, propagateToUpperContext, em),
    );
  }

  /**
   * Creates new transaction context (REQUIRED).
   */
  private async createNewTransaction<T>(
    em: EntityManager,
    cb: (em: EntityManager) => T | Promise<T>,
    options: TransactionOptions,
  ): Promise<T> {
    const fork = this.createFork(em, options);
    return this.processTransaction(em, fork, cb, options);
  }

  /**
   * Executes nested transaction with savepoint (NESTED).
   */
  private async executeNestedTransaction<T>(
    em: EntityManager,
    cb: (em: EntityManager) => T | Promise<T>,
    options: TransactionOptions,
  ): Promise<T> {
    const fork = this.createFork(em, options);

    // Pass existing context to create savepoint in SQL databases
    const nestedOptions = { ...options, ctx: em.getTransactionContext() };
    return this.processTransaction(em, fork, cb, nestedOptions);
  }

  /**
   * Adjusts transaction options for platform compatibility.
   */
  private adjustPlatformOptions(
    platform: Platform,
    options: TransactionOptions,
  ): TransactionOptions {
    const adjustedOptions = { ...options };

    // MongoDB REQUIRES_NEW: always create new session
    if (!platform.supportsSavepoints() && adjustedOptions.propagation === TransactionPropagation.REQUIRES_NEW) {
      adjustedOptions.ctx = undefined;
      return adjustedOptions;
    }

    // SQLite REQUIRES_NEW fallback
    if (adjustedOptions.propagation !== TransactionPropagation.REQUIRES_NEW || !adjustedOptions.ctx) {
      return adjustedOptions;
    }

    const fallback = platform.getTransactionPropagationFallback(TransactionPropagation.REQUIRES_NEW);
    if (!fallback) {
      adjustedOptions.ctx = undefined;
      return adjustedOptions;
    }

    // Use fallback propagation (e.g., NESTED for SQLite)
    adjustedOptions.propagation = fallback;
    return adjustedOptions;
  }

  /**
   * Creates a fork of the EntityManager with the given options.
   */
  private createFork(em: EntityManager, options: TransactionOptions): EntityManager {
    return em.fork({
      clear: options.clear ?? false,
      flushMode: options.flushMode,
      cloneEventManager: true,
      disableTransactions: options.ignoreNestedTransactions,
      loggerContext: options.loggerContext,
    }) as EntityManager;
  }

  /**
   * Determines if changes should be propagated to the upper context.
   */
  private shouldPropagateToUpperContext(em: EntityManager): boolean {
    return !em.global || this.em.config.get('allowGlobalContext');
  }

  /**
   * Merges entities from fork to parent EntityManager.
   */
  private mergeEntitiesToParent(fork: EntityManager, parent: EntityManager): void {
    for (const entity of fork.getUnitOfWork(false).getIdentityMap()) {
      parent.merge(entity, { disableContextResolution: true, keepIdentity: true, refresh: true });
    }
  }

  /**
   * Registers a deletion handler to unset entity identities after flush.
   */
  private registerDeletionHandler(fork: EntityManager, parent: EntityManager): void {
    const handler = this.createDeletionHandler(parent);
    fork.getEventManager().registerSubscriber({ afterFlush: handler });
  }

  /**
   * Creates a handler for deletion events.
   */
  private createDeletionHandler(parent: EntityManager): (args: FlushEventArgs) => void {
    return (args: FlushEventArgs) => {
      const deletionChangeSets = args.uow.getChangeSets()
        .filter(cs => cs.type === ChangeSetType.DELETE || cs.type === ChangeSetType.DELETE_EARLY);

      deletionChangeSets.forEach(cs =>
        parent.getUnitOfWork(false).unsetIdentity(cs.entity),
      );
    };
  }

  /**
   * Processes transaction execution with platform-specific handling.
   */
  private async processTransaction<T>(
    em: EntityManager,
    fork: EntityManager,
    cb: (em: EntityManager) => T | Promise<T>,
    options: TransactionOptions,
  ): Promise<T> {
    const propagateToUpperContext = this.shouldPropagateToUpperContext(em);
    const connection = fork.getConnection();
    const platform = connection.getPlatform();

    // Resolve platform-specific propagation adjustments
    const adjustedOptions = this.adjustPlatformOptions(platform, options);

    // Case 1: Reuse existing session (MongoDB REQUIRED/NESTED with existing context)
    if (this.shouldReuseSession(adjustedOptions, platform)) {
      return this.executeWithExistingSession(fork, cb, adjustedOptions, propagateToUpperContext, em);
    }

    // Case 2: Execute without transaction context (MongoDB NOT_SUPPORTED)
    if (this.shouldExecuteWithoutTransaction(adjustedOptions, platform)) {
      return this.executeWithoutTransactionContext(fork, cb, propagateToUpperContext, em);
    }

    // Case 3: Standard transaction creation (all platforms)
    return this.executeInNewTransactionContext(fork, cb, adjustedOptions, propagateToUpperContext, em, connection);
  }

  /**
   * Determines if we should reuse an existing session/transaction.
   */
  private shouldReuseSession(options: TransactionOptions, platform: Platform): boolean {
    // MongoDB reuses session for REQUIRED/NESTED with existing context
    return !platform.supportsSavepoints() &&
           options.ctx &&
           (options.propagation === TransactionPropagation.REQUIRED ||
            options.propagation === TransactionPropagation.NESTED);
  }

  /**
   * Determines if we should execute without a transaction context.
   */
  private shouldExecuteWithoutTransaction(options: TransactionOptions, platform: Platform): boolean {
    // MongoDB NOT_SUPPORTED propagation
    return !platform.supportsSavepoints() &&
           options.propagation === TransactionPropagation.NOT_SUPPORTED;
  }

  /**
   * Executes callback with an existing session/transaction context.
   */
  private async executeWithExistingSession<T>(
    fork: EntityManager,
    cb: (em: EntityManager) => T | Promise<T>,
    options: TransactionOptions,
    propagateToUpperContext: boolean,
    parentEm: EntityManager,
  ): Promise<T> {
    fork.setTransactionContext(options.ctx!);
    return TransactionContext.create(fork, () =>
      this.executeTransactionFlow(fork, cb, propagateToUpperContext, parentEm),
    );
  }

  /**
   * Executes callback without transaction context.
   */
  private async executeWithoutTransactionContext<T>(
    fork: EntityManager,
    cb: (em: EntityManager) => T | Promise<T>,
    propagateToUpperContext: boolean,
    parentEm: EntityManager,
  ): Promise<T> {
    fork.setTransactionContext(null!); // Special marker for no transaction
    return TransactionContext.create(fork, () =>
      this.executeTransactionFlow(fork, cb, propagateToUpperContext, parentEm),
    );
  }

  /**
   * Creates and executes a new transaction context.
   */
  private async executeInNewTransactionContext<T>(
    fork: EntityManager,
    cb: (em: EntityManager) => T | Promise<T>,
    options: TransactionOptions,
    propagateToUpperContext: boolean,
    parentEm: EntityManager,
    connection: any,
  ): Promise<T> {
    const eventBroadcaster = new TransactionEventBroadcaster(
      fork,
      undefined,
      { topLevelTransaction: !options.ctx },
    );

    return TransactionContext.create(fork, () =>
      this.executeConnectionTransaction(
        connection,
        fork,
        cb,
        { ...options, eventBroadcaster },
        propagateToUpperContext,
        parentEm,
      ),
    );
  }

  /**
   * Executes transaction through database connection.
   */
  private async executeConnectionTransaction<T>(
    connection: Connection,
    fork: EntityManager,
    cb: (em: EntityManager) => T | Promise<T>,
    options: TransactionOptions & { eventBroadcaster: TransactionEventBroadcaster },
    propagateToUpperContext: boolean,
    parentEm: EntityManager,
  ): Promise<T> {
    return connection.transactional(async trx => {
      fork.setTransactionContext(trx);
      return this.executeTransactionFlow(fork, cb, propagateToUpperContext, parentEm);
    }, options);
  }

  /**
   * Executes transaction workflow with entity synchronization.
   */
  private async executeTransactionFlow<T>(
    fork: EntityManager,
    cb: (em: EntityManager) => T | Promise<T>,
    propagateToUpperContext: boolean,
    parentEm: EntityManager,
  ): Promise<T> {
    if (!propagateToUpperContext) {
      const ret = await cb(fork);
      await fork.flush();
      return ret;
    }

    // Setup: Register deletion handler before execution
    this.registerDeletionHandler(fork, parentEm);

    // Execute callback and flush
    const ret = await cb(fork);
    await fork.flush();

    // Cleanup: Merge entities back to parent
    this.mergeEntitiesToParent(fork, parentEm);

    return ret;
  }

}
