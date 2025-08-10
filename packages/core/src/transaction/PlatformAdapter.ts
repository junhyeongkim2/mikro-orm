import type { Platform } from '../platforms/Platform';
import { TransactionPropagation, type TransactionOptions } from '../enums';

/**
 * Adapter class to centralize platform-specific transaction handling logic.
 * This helps reduce complexity in TransactionHandler by isolating platform differences.
 */
export class PlatformAdapter {

  constructor(private readonly platform: Platform) {}

  /**
   * Checks if the platform supports independent transactions.
   * SQLite with in-memory databases doesn't support this due to single connection limitation.
   */
  supportsIndependentTransactions(): boolean {
    return this.platform.supportsIndependentTransactions();
  }

  /**
   * Checks if the platform supports savepoints for nested transactions.
   * MongoDB doesn't support savepoints.
   */
  supportsSavepoints(): boolean {
    return this.platform.supportsSavepoints();
  }

  /**
   * Resolves propagation type based on platform capabilities.
   * Applies fallbacks for platforms with limitations.
   */
  resolvePropagation(
    propagation: TransactionPropagation | undefined,
    hasExistingTransaction: boolean,
    options: TransactionOptions,
  ): TransactionPropagation | undefined {
    // Handle NOT_SUPPORTED with existing transaction on platforms without suspend capability
    if (propagation === TransactionPropagation.NOT_SUPPORTED) {
      if (hasExistingTransaction && !this.supportsIndependentTransactions()) {
        // SQLite: Cannot suspend, use NESTED (savepoint) instead
        return TransactionPropagation.NESTED;
      }
      return propagation;
    }

    // Handle REQUIRES_NEW on platforms without independent transaction support
    if (propagation === TransactionPropagation.REQUIRES_NEW) {
      if (hasExistingTransaction && !this.supportsIndependentTransactions()) {
        // SQLite: Cannot create independent transaction, fallback to NESTED
        const fallback = this.platform.getTransactionPropagationFallback(TransactionPropagation.REQUIRES_NEW);
        return fallback || TransactionPropagation.NESTED;
      }
      return propagation;
    }

    if (propagation) {
      return propagation;
    }

    // Handle backward compatibility for ignoreNestedTransactions
    if (options.ignoreNestedTransactions) {
      return TransactionPropagation.REQUIRED;
    }

    // MongoDB: No savepoints, return undefined to trigger original flow
    if (hasExistingTransaction && !this.supportsSavepoints()) {
      return undefined;
    }

    // Default behavior
    return hasExistingTransaction ? TransactionPropagation.NESTED : TransactionPropagation.REQUIRED;
  }

  /**
   * Adjusts transaction options based on platform capabilities.
   * Handles context passing for platforms with limitations.
   */
  adjustOptionsForPlatform(
    options: TransactionOptions,
    hasExistingTransaction: boolean,
  ): TransactionOptions {
    const adjustedOptions = { ...options };

    // MongoDB: Handle session management for different propagation types
    if (!this.supportsSavepoints()) {
      if (adjustedOptions.propagation === TransactionPropagation.REQUIRES_NEW) {
        // Always create new session for REQUIRES_NEW
        adjustedOptions.ctx = undefined;
      } else if (adjustedOptions.propagation === TransactionPropagation.NOT_SUPPORTED) {
        // Execute without transaction context
        adjustedOptions.ctx = null;
      }
      // REQUIRED and NESTED reuse existing session (ctx remains as-is)
    }

    // SQLite: Handle REQUIRES_NEW fallback
    if (adjustedOptions.propagation === TransactionPropagation.REQUIRES_NEW &&
        hasExistingTransaction && !this.supportsIndependentTransactions()) {
      // Keep existing context for fallback to NESTED
      // Context will be used to create savepoint
    }

    return adjustedOptions;
  }

  /**
   * Determines if the platform needs special handling for NOT_SUPPORTED propagation.
   */
  needsSpecialNotSupportedHandling(): boolean {
    return !this.supportsSavepoints(); // MongoDB
  }

  /**
   * Determines if the platform needs special handling for session reuse.
   */
  needsSessionReuse(propagation: TransactionPropagation | undefined, hasContext: boolean): boolean {
    if (!this.supportsSavepoints()) {
      // MongoDB: Reuse session for REQUIRED and NESTED with existing context
      return hasContext && (
        propagation === TransactionPropagation.REQUIRED ||
        propagation === TransactionPropagation.NESTED
      );
    }
    return false;
  }

}
