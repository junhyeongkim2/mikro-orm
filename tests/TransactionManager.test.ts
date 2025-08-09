import { EntityManager, TransactionPropagation, IsolationLevel, FlushMode, Platform, Connection, UnitOfWork, EventManager, Configuration } from '@mikro-orm/core';
import { TransactionManager } from '../packages/core/src/transaction/TransactionManager';
import { PlatformAdapter } from '../packages/core/src/transaction/PlatformAdapter';
import { TransactionContext } from '../packages/core/src/utils/TransactionContext';

describe('TransactionManager', () => {
  let em: jest.Mocked<EntityManager>;
  let transactionManager: TransactionManager;
  let mockConnection: jest.Mocked<Connection>;
  let mockPlatform: jest.Mocked<Platform>;
  let mockUnitOfWork: jest.Mocked<UnitOfWork>;
  let mockEventManager: jest.Mocked<EventManager>;
  let mockConfig: jest.Mocked<Configuration>;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    // Create mock objects
    mockConnection = {
      transactional: jest.fn(),
      getPlatform: jest.fn(),
    } as any;

    mockPlatform = {
      supportsSavepoints: jest.fn().mockReturnValue(true),
      supportsIndependentTransactions: jest.fn().mockReturnValue(true),
      getTransactionPropagationFallback: jest.fn(),
    } as any;

    mockUnitOfWork = {
      getIdentityMap: jest.fn().mockReturnValue([]),
      unsetIdentity: jest.fn(),
      getChangeSets: jest.fn().mockReturnValue([]),
    } as any;

    mockEventManager = {
      registerSubscriber: jest.fn(),
    } as any;

    mockConfig = {
      get: jest.fn().mockReturnValue(false),
    } as any;

    // Create mock EntityManager
    em = {
      getContext: jest.fn().mockReturnThis(),
      getConnection: jest.fn().mockReturnValue(mockConnection),
      getPlatform: jest.fn().mockReturnValue(mockPlatform),
      getTransactionContext: jest.fn(),
      setTransactionContext: jest.fn(),
      fork: jest.fn(),
      merge: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
      persistAndFlush: jest.fn().mockResolvedValue(undefined),
      getUnitOfWork: jest.fn().mockReturnValue(mockUnitOfWork),
      getEventManager: jest.fn().mockReturnValue(mockEventManager),
      findOne: jest.fn(),
      count: jest.fn(),
      config: mockConfig,
      global: false,
      isTransactionsDisabled: false,
    } as any;

    mockConnection.getPlatform.mockReturnValue(mockPlatform);

    // Create TransactionManager instance
    transactionManager = new TransactionManager(em);
  });

  describe('handle()', () => {
    it('should execute callback directly when transactions are disabled', async () => {
      (em as any).isTransactionsDisabled = true;
      const callback = jest.fn().mockResolvedValue('result');

      const result = await transactionManager.handle(callback);

      expect(result).toBe('result');
      expect(callback).toHaveBeenCalledWith(em);
      expect(mockConnection.transactional).not.toHaveBeenCalled();
    });

    it('should use default transaction when no propagation is specified', async () => {
      const callback = jest.fn().mockResolvedValue('result');
      const mockFork = { ...em } as any;
      em.fork.mockReturnValue(mockFork);

      // Mock TransactionContext.create to execute callback immediately
      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      mockConnection.transactional.mockImplementation(async cb => {
        mockFork.setTransactionContext({});
        return cb({});
      });

      const result = await transactionManager.handle(callback);

      expect(em.fork).toHaveBeenCalled();
      expect(mockConnection.transactional).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(mockFork);
    });

    it('should handle REQUIRED propagation with existing transaction', async () => {
      const callback = jest.fn().mockResolvedValue('result');
      const existingContext = { id: 'existing' };
      em.getTransactionContext.mockReturnValue(existingContext);

      const mockFork = {
        ...em,
        setTransactionContext: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
      } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      const result = await transactionManager.handle(callback, {
        propagation: TransactionPropagation.REQUIRED,
      });

      expect(mockFork.setTransactionContext).toHaveBeenCalledWith(existingContext);
      expect(callback).toHaveBeenCalledWith(mockFork);
      expect(mockConnection.transactional).not.toHaveBeenCalled();
    });

    it('should handle REQUIRED propagation without existing transaction', async () => {
      const callback = jest.fn().mockResolvedValue('result');
      em.getTransactionContext.mockReturnValue(null);

      const mockFork = { ...em } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      mockConnection.transactional.mockImplementation(async cb => {
        mockFork.setTransactionContext({});
        return cb({});
      });

      const result = await transactionManager.handle(callback, {
        propagation: TransactionPropagation.REQUIRED,
      });

      expect(mockConnection.transactional).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(mockFork);
    });
  });

  describe('REQUIRES_NEW propagation', () => {
    it('should create new independent transaction', async () => {
      const callback = jest.fn().mockResolvedValue('result');
      const existingContext = { id: 'existing' };
      em.getTransactionContext.mockReturnValue(existingContext);

      const mockFork = {
        ...em,
        setTransactionContext: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
      } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      const newContext = { id: 'new' };
      mockConnection.transactional.mockImplementation(async cb => {
        mockFork.setTransactionContext(newContext);
        return cb(newContext);
      });

      const result = await transactionManager.handle(callback, {
        propagation: TransactionPropagation.REQUIRES_NEW,
      });

      // Should suspend existing transaction
      expect(em.setTransactionContext).toHaveBeenCalledWith(null);

      // Should create new transaction
      expect(mockConnection.transactional).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(mockFork);

      // Should resume suspended transaction
      expect(em.setTransactionContext).toHaveBeenCalledWith(existingContext);
    });

    it('should handle SQLite fallback for REQUIRES_NEW', async () => {
      const callback = jest.fn().mockResolvedValue('result');
      const existingContext = { id: 'existing' };
      em.getTransactionContext.mockReturnValue(existingContext);

      // Mock SQLite platform that doesn't support independent transactions
      mockPlatform.supportsSavepoints.mockReturnValue(true);
      mockPlatform.getTransactionPropagationFallback.mockReturnValue(TransactionPropagation.NESTED);

      mockPlatform.supportsIndependentTransactions.mockReturnValue(false);
      jest.spyOn(PlatformAdapter.prototype, 'resolvePropagation').mockReturnValue(TransactionPropagation.NESTED);

      const mockFork = {
        ...em,
        setTransactionContext: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
      } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      mockConnection.transactional.mockImplementation(async (cb, options) => {
        // Should pass existing context for savepoint creation
        expect((options as any)?.ctx).toBe(existingContext);
        mockFork.setTransactionContext(existingContext);
        return cb(existingContext);
      });

      const result = await transactionManager.handle(callback, {
        propagation: TransactionPropagation.REQUIRES_NEW,
      });

      expect(callback).toHaveBeenCalledWith(mockFork);
      expect(mockConnection.transactional).toHaveBeenCalled();
    });
  });

  describe('NESTED propagation', () => {
    it('should create savepoint when transaction exists', async () => {
      const callback = jest.fn().mockResolvedValue('result');
      const existingContext = { id: 'existing' };
      em.getTransactionContext.mockReturnValue(existingContext);

      const mockFork = {
        ...em,
        setTransactionContext: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
      } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      mockConnection.transactional.mockImplementation(async (cb, options) => {
        // Should pass existing context for savepoint creation
        expect((options as any)?.ctx).toBe(existingContext);
        mockFork.setTransactionContext(existingContext);
        return cb(existingContext);
      });

      await transactionManager.handle(callback, {
        propagation: TransactionPropagation.NESTED,
      });

      expect(mockConnection.transactional).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(mockFork);
    });

    it('should create new transaction when none exists', async () => {
      const callback = jest.fn().mockResolvedValue('result');
      em.getTransactionContext.mockReturnValue(null);

      const mockFork = { ...em } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      const newContext = { id: 'new' };
      mockConnection.transactional.mockImplementation(async cb => {
        mockFork.setTransactionContext(newContext);
        return cb(newContext);
      });

      await transactionManager.handle(callback, {
        propagation: TransactionPropagation.NESTED,
      });

      expect(mockConnection.transactional).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(mockFork);
    });
  });

  describe('NOT_SUPPORTED propagation', () => {
    it('should suspend existing transaction and execute without transaction', async () => {
      const callback = jest.fn().mockResolvedValue('result');
      const existingContext = { id: 'existing' };
      em.getTransactionContext.mockReturnValue(existingContext);

      const mockFork = {
        ...em,
        setTransactionContext: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
      } as any;
      em.fork.mockReturnValue(mockFork);

      const result = await transactionManager.handle(callback, {
        propagation: TransactionPropagation.NOT_SUPPORTED,
      });

      // Should suspend existing transaction
      expect(em.setTransactionContext).toHaveBeenCalledWith(null);

      // For NOT_SUPPORTED, the fork should be executed without transaction
      expect(callback).toHaveBeenCalledWith(mockFork);

      // Should resume suspended transaction
      expect(em.setTransactionContext).toHaveBeenCalledWith(existingContext);
    });

    it('should execute without transaction when none exists', async () => {
      const callback = jest.fn().mockResolvedValue('result');
      em.getTransactionContext.mockReturnValue(null);

      const mockFork = {
        ...em,
        flush: jest.fn().mockResolvedValue(undefined),
      } as any;
      em.fork.mockReturnValue(mockFork);

      const result = await transactionManager.handle(callback, {
        propagation: TransactionPropagation.NOT_SUPPORTED,
      });

      // NOT_SUPPORTED without existing transaction should just execute without creating a transaction
      expect(callback).toHaveBeenCalledWith(mockFork);
    });
  });

  describe('MongoDB-specific behavior', () => {
    beforeEach(() => {
      mockPlatform.supportsSavepoints.mockReturnValue(false);
    });

    it('should reuse session for REQUIRED with existing context', async () => {
      const callback = jest.fn().mockResolvedValue('result');
      const existingContext = { id: 'mongo-session' };
      em.getTransactionContext.mockReturnValue(existingContext);

      const mockFork = {
        ...em,
        setTransactionContext: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
      } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      const result = await transactionManager.handle(callback, {
        propagation: TransactionPropagation.REQUIRED,
        ctx: existingContext,
      });

      expect(mockFork.setTransactionContext).toHaveBeenCalledWith(existingContext);
      expect(mockConnection.transactional).not.toHaveBeenCalled();
    });

    it('should create new session for REQUIRES_NEW', async () => {
      const callback = jest.fn().mockResolvedValue('result');
      em.getTransactionContext.mockReturnValue(null);

      const mockFork = { ...em } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      const newSession = { id: 'new-mongo-session' };
      mockConnection.transactional.mockImplementation(async cb => {
        mockFork.setTransactionContext(newSession);
        return cb(newSession);
      });

      const result = await transactionManager.handle(callback, {
        propagation: TransactionPropagation.REQUIRES_NEW,
      });

      expect(mockConnection.transactional).toHaveBeenCalled();
      const callOptions = mockConnection.transactional.mock.calls[0][1];
      expect(callOptions?.ctx).toBeUndefined();
    });

    it('should handle NESTED as REQUIRED for MongoDB', async () => {
      const callback = jest.fn().mockResolvedValue('result');
      const existingContext = { id: 'mongo-session' };
      em.getTransactionContext.mockReturnValue(existingContext);

      jest.spyOn(PlatformAdapter.prototype, 'resolvePropagation').mockReturnValue(TransactionPropagation.REQUIRED);

      const mockFork = {
        ...em,
        setTransactionContext: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
      } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      const result = await transactionManager.handle(callback, {
        propagation: TransactionPropagation.NESTED,
      });

      expect(mockFork.setTransactionContext).toHaveBeenCalledWith(existingContext);
    });

    it('should execute without transaction for NOT_SUPPORTED', async () => {
      const callback = jest.fn().mockResolvedValue('result');
      const existingContext = { id: 'mongo-session' };
      em.getTransactionContext.mockReturnValue(existingContext);

      const mockFork = {
        ...em,
        setTransactionContext: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
      } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      const result = await transactionManager.handle(callback, {
        propagation: TransactionPropagation.NOT_SUPPORTED,
      });

      // For MongoDB NOT_SUPPORTED, transaction should be suspended
      expect(em.setTransactionContext).toHaveBeenCalledWith(null);
      expect(callback).toHaveBeenCalledWith(mockFork);
    });
  });

  describe('Entity synchronization', () => {
    it('should merge entities from fork to parent after transaction', async () => {
      const callback = jest.fn().mockResolvedValue('result');
      const entity1 = { id: 1, name: 'entity1' };
      const entity2 = { id: 2, name: 'entity2' };

      // Mock getIdentityMap to return an iterable
      (mockUnitOfWork.getIdentityMap as jest.Mock).mockReturnValue({
        *[Symbol.iterator]() {
          yield entity1;
          yield entity2;
        },
      });

      const mockFork = {
        ...em,
        getUnitOfWork: jest.fn().mockReturnValue(mockUnitOfWork),
        flush: jest.fn().mockResolvedValue(undefined),
      } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      mockConnection.transactional.mockImplementation(async cb => {
        mockFork.setTransactionContext({});
        return cb({});
      });

      await transactionManager.handle(callback, {
        propagation: TransactionPropagation.REQUIRED,
      });

      expect(em.merge).toHaveBeenCalledWith(entity1, expect.objectContaining({
        disableContextResolution: true,
        keepIdentity: true,
        refresh: true,
      }));
      expect(em.merge).toHaveBeenCalledWith(entity2, expect.objectContaining({
        disableContextResolution: true,
        keepIdentity: true,
        refresh: true,
      }));
    });

    it('should register deletion handler for flush events', async () => {
      const callback = jest.fn().mockResolvedValue('result');

      const mockFork = {
        ...em,
        getEventManager: jest.fn().mockReturnValue(mockEventManager),
        flush: jest.fn().mockResolvedValue(undefined),
      } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      mockConnection.transactional.mockImplementation(async cb => {
        mockFork.setTransactionContext({});
        return cb({});
      });

      await transactionManager.handle(callback, {
        propagation: TransactionPropagation.REQUIRED,
      });

      expect(mockEventManager.registerSubscriber).toHaveBeenCalledWith(
        expect.objectContaining({
          afterFlush: expect.any(Function),
        }),
      );
    });
  });

  describe('Transaction options', () => {
    it('should apply isolation level', async () => {
      const callback = jest.fn().mockResolvedValue('result');

      const mockFork = { ...em } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      mockConnection.transactional.mockImplementation(async (cb, options) => {
        expect(options?.isolationLevel).toBe(IsolationLevel.SERIALIZABLE);
        mockFork.setTransactionContext({});
        return cb({});
      });

      await transactionManager.handle(callback, {
        propagation: TransactionPropagation.REQUIRED,
        isolationLevel: IsolationLevel.SERIALIZABLE,
      });

      expect(mockConnection.transactional).toHaveBeenCalled();
    });

    it('should apply flush mode to forked entity manager', async () => {
      const callback = jest.fn().mockResolvedValue('result');

      em.fork.mockImplementation(options => {
        expect(options?.flushMode).toBe(FlushMode.COMMIT);
        return { ...em } as any;
      });

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      mockConnection.transactional.mockImplementation(async cb => cb({}));

      await transactionManager.handle(callback, {
        propagation: TransactionPropagation.REQUIRED,
        flushMode: FlushMode.COMMIT,
      });

      expect(em.fork).toHaveBeenCalledWith(expect.objectContaining({
        flushMode: FlushMode.COMMIT,
      }));
    });

    it('should clear identity map when specified', async () => {
      const callback = jest.fn().mockResolvedValue('result');

      em.fork.mockImplementation(options => {
        expect(options?.clear).toBe(true);
        return { ...em } as any;
      });

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      mockConnection.transactional.mockImplementation(async cb => cb({}));

      await transactionManager.handle(callback, {
        propagation: TransactionPropagation.REQUIRED,
        clear: true,
      });

      expect(em.fork).toHaveBeenCalledWith(expect.objectContaining({
        clear: true,
      }));
    });

    it('should handle read-only transactions', async () => {
      const callback = jest.fn().mockResolvedValue('result');

      const mockFork = { ...em } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      mockConnection.transactional.mockImplementation(async (cb, options) => {
        expect(options?.readOnly).toBe(true);
        mockFork.setTransactionContext({});
        return cb({});
      });

      await transactionManager.handle(callback, {
        propagation: TransactionPropagation.REQUIRED,
        readOnly: true,
      });

      expect(mockConnection.transactional).toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should propagate errors from callback', async () => {
      const error = new Error('Callback error');
      const callback = jest.fn().mockRejectedValue(error);

      const mockFork = { ...em } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      mockConnection.transactional.mockImplementation(async cb => {
        mockFork.setTransactionContext({});
        return cb({});
      });

      await expect(transactionManager.handle(callback, {
        propagation: TransactionPropagation.REQUIRED,
      })).rejects.toThrow(error);
    });

    it('should resume suspended transaction even on error', async () => {
      const error = new Error('Callback error');
      const callback = jest.fn().mockRejectedValue(error);
      const existingContext = { id: 'existing' };
      em.getTransactionContext.mockReturnValue(existingContext);

      const mockFork = {
        ...em,
        setTransactionContext: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
      } as any;
      em.fork.mockReturnValue(mockFork);

      await expect(transactionManager.handle(callback, {
        propagation: TransactionPropagation.NOT_SUPPORTED,
      })).rejects.toThrow(error);

      // Should still resume suspended transaction after error
      expect(em.setTransactionContext).toHaveBeenLastCalledWith(existingContext);
    });

    it('should throw error for unsupported propagation type', async () => {
      const callback = jest.fn();

      jest.spyOn(PlatformAdapter.prototype, 'resolvePropagation').mockReturnValue('UNSUPPORTED' as any);

      await expect(transactionManager.handle(callback, {
        propagation: 'UNSUPPORTED' as any,
      })).rejects.toThrow('Unsupported transaction propagation type: UNSUPPORTED');
    });
  });

  describe('Complex scenarios', () => {
    it('should handle deeply nested transactions', async () => {
      const callback = jest.fn().mockResolvedValue('deeply-nested-result');

      // Mock PlatformAdapter to return valid propagation values
      jest.spyOn(PlatformAdapter.prototype, 'resolvePropagation')
        .mockReturnValueOnce(TransactionPropagation.REQUIRED)
        .mockReturnValueOnce(TransactionPropagation.REQUIRED)
        .mockReturnValueOnce(TransactionPropagation.NESTED);

      const mockFork = {
        ...em,
        setTransactionContext: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
      } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      const existingContext = { id: 'existing' };
      em.getTransactionContext
        .mockReturnValueOnce(null) // First call - no context
        .mockReturnValue(existingContext); // Subsequent calls - has context

      mockConnection.transactional.mockImplementation(async cb => {
        mockFork.setTransactionContext(existingContext);
        em.getTransactionContext.mockReturnValue(existingContext);
        return cb(existingContext);
      });

      const result = await transactionManager.handle(callback, {
        propagation: TransactionPropagation.REQUIRED,
      });

      expect(result).toBe('deeply-nested-result');
      expect(callback).toHaveBeenCalled();
    });

    it('should handle mixed propagation types in sequence', async () => {
      // Mock PlatformAdapter to return correct propagation values
      jest.spyOn(PlatformAdapter.prototype, 'resolvePropagation')
        .mockReturnValueOnce(TransactionPropagation.REQUIRED)
        .mockReturnValueOnce(TransactionPropagation.REQUIRES_NEW)
        .mockReturnValueOnce(TransactionPropagation.NOT_SUPPORTED);

      const mockFork = {
        ...em,
        setTransactionContext: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
      } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());
      mockConnection.transactional.mockImplementation(async cb => cb({}));

      // Test REQUIRED propagation
      em.getTransactionContext.mockReturnValue(null);
      const result1 = await transactionManager.handle(async () => 'required', {
        propagation: TransactionPropagation.REQUIRED,
      });
      expect(result1).toBe('required');

      // Test REQUIRES_NEW propagation
      em.getTransactionContext.mockReturnValue({ id: 'existing' });
      const result2 = await transactionManager.handle(async () => 'requires-new', {
        propagation: TransactionPropagation.REQUIRES_NEW,
      });
      expect(result2).toBe('requires-new');

      // Test NOT_SUPPORTED propagation
      const result3 = await transactionManager.handle(async () => 'not-supported', {
        propagation: TransactionPropagation.NOT_SUPPORTED,
      });
      expect(result3).toBe('not-supported');
    });
  });

  describe('Platform adapter integration', () => {
    it('should use PlatformAdapter for propagation resolution', async () => {
      const callback = jest.fn().mockResolvedValue('result');
      const spy = jest.spyOn(PlatformAdapter.prototype, 'resolvePropagation').mockReturnValue(TransactionPropagation.REQUIRED);

      const mockFork = {
        ...em,
        setTransactionContext: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
      } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());
      mockConnection.transactional.mockImplementation(async cb => cb({}));

      await transactionManager.handle(callback, {
        propagation: TransactionPropagation.REQUIRED,
      });

      expect(spy).toHaveBeenCalledWith(
        TransactionPropagation.REQUIRED,
        false,
        expect.objectContaining({ propagation: TransactionPropagation.REQUIRED }),
      );
    });

    it('should respect platform-specific fallbacks', async () => {
      const callback = jest.fn().mockResolvedValue('result');

      // Configure platform to fallback REQUIRES_NEW to NESTED
      mockPlatform.getTransactionPropagationFallback.mockReturnValue(TransactionPropagation.NESTED);
      mockPlatform.supportsIndependentTransactions.mockReturnValue(false);
      jest.spyOn(PlatformAdapter.prototype, 'resolvePropagation').mockReturnValue(TransactionPropagation.NESTED);

      const existingContext = { id: 'existing' };
      em.getTransactionContext.mockReturnValue(existingContext);

      const mockFork = {
        ...em,
        setTransactionContext: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
      } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      mockConnection.transactional.mockImplementation(async (cb, options) => {
        // Should use NESTED behavior (savepoint with existing context)
        expect((options as any)?.propagation).toBe(TransactionPropagation.NESTED);
        expect((options as any)?.ctx).toBe(existingContext);
        return cb(existingContext);
      });

      await transactionManager.handle(callback, {
        propagation: TransactionPropagation.REQUIRES_NEW,
      });

      expect(mockPlatform.getTransactionPropagationFallback).toHaveBeenCalledWith(
        TransactionPropagation.REQUIRES_NEW,
      );
    });
  });

  describe('Global context handling', () => {
    it('should not propagate to upper context when global', async () => {
      const callback = jest.fn().mockResolvedValue('result');
      (em as any).global = true;
      mockConfig.get.mockReturnValue(false); // allowGlobalContext = false

      const mockFork = {
        ...em,
        setTransactionContext: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
        getUnitOfWork: jest.fn().mockReturnValue(mockUnitOfWork),
      } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      mockConnection.transactional.mockImplementation(async cb => {
        mockFork.setTransactionContext({});
        return cb({});
      });

      await transactionManager.handle(callback, {
        propagation: TransactionPropagation.REQUIRED,
      });

      // Should not merge entities when not propagating to upper context
      expect(em.merge).not.toHaveBeenCalled();
    });

    it('should propagate to upper context when allowGlobalContext is true', async () => {
      const callback = jest.fn().mockResolvedValue('result');
      (em as any).global = true;
      mockConfig.get.mockReturnValue(true); // allowGlobalContext = true

      const entity = { id: 1, name: 'test' };
      // Mock getIdentityMap to return an iterable
      (mockUnitOfWork.getIdentityMap as jest.Mock).mockReturnValue({
        *[Symbol.iterator]() {
          yield entity;
        },
      });

      const mockFork = {
        ...em,
        setTransactionContext: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
        getUnitOfWork: jest.fn().mockReturnValue(mockUnitOfWork),
        getEventManager: jest.fn().mockReturnValue(mockEventManager),
      } as any;
      em.fork.mockReturnValue(mockFork);

      jest.spyOn(TransactionContext, 'create').mockImplementation(async (em, cb) => cb());

      mockConnection.transactional.mockImplementation(async cb => {
        mockFork.setTransactionContext({});
        return cb({});
      });

      await transactionManager.handle(callback, {
        propagation: TransactionPropagation.REQUIRED,
      });

      // Should merge entities when propagating to upper context
      expect(em.merge).toHaveBeenCalledWith(entity, expect.any(Object));
    });
  });
});
