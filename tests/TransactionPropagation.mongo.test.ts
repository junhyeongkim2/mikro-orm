import { MikroORM, TransactionPropagation } from '@mikro-orm/mongodb';
import { Author } from './entities';
import { initORMMongo } from './bootstrap';

describe('Transaction Propagation - MongoDB', () => {
  let orm: MikroORM;

  beforeAll(async () => orm = await initORMMongo(true));
  beforeEach(async () => orm.schema.clearDatabase());
  afterAll(async () => orm.close());

  beforeEach(async () => {
    await orm.em.nativeDelete(Author, {});
  });

  describe('REQUIRED propagation', () => {
    it('should join existing transaction', async () => {
      const em = orm.em.fork();
      let outerSession: any;
      let innerSession: any;

      await em.transactional(async em1 => {
        outerSession = (em1 as any).transactionContext;

        await em1.transactional(async em2 => {
          innerSession = (em2 as any).transactionContext;
          const entity = new Author('test', 'test@test.com');
          await em2.persistAndFlush(entity);
        }, { propagation: TransactionPropagation.REQUIRED });
      });

      expect(outerSession).toBeDefined();
      expect(innerSession).toBe(outerSession); // Should be same session

      const count = await orm.em.count(Author);
      expect(count).toBe(1);
    });

    it('should create new transaction if none exists', async () => {
      const em = orm.em.fork();
      let session: any;

      await em.transactional(async em1 => {
        session = (em1 as any).transactionContext;
        const entity = new Author('test', 'test@test.com');
        await em1.persistAndFlush(entity);
      }, { propagation: TransactionPropagation.REQUIRED });

      expect(session).toBeDefined();
      const count = await orm.em.count(Author);
      expect(count).toBe(1);
    });

    it('should rollback all operations when inner transaction fails', async () => {
      const em = orm.em.fork();

      try {
        await em.transactional(async em1 => {
          const entity1 = new Author('outer', 'outer@test.com');
          await em1.persistAndFlush(entity1);

          await em1.transactional(async em2 => {
            const entity2 = new Author('inner', 'inner@test.com');
            await em2.persistAndFlush(entity2);
            throw new Error('Inner error');
          }, { propagation: TransactionPropagation.REQUIRED });
        });
      } catch (e) {
        // Expected error
      }

      // Both operations should be rolled back
      const count = await orm.em.count(Author);
      expect(count).toBe(0);
    });
  });

  describe('REQUIRES_NEW propagation', () => {
    it('should create new independent transaction', async () => {
      const em = orm.em.fork();
      let outerSession: any;
      let innerSession: any;

      await em.transactional(async em1 => {
        outerSession = (em1 as any).transactionContext;
        const entity1 = new Author('outer', 'outer@test.com');
        await em1.persistAndFlush(entity1);

        await em1.transactional(async em2 => {
          innerSession = (em2 as any).transactionContext;
          const entity2 = new Author('inner', 'inner@test.com');
          await em2.persistAndFlush(entity2);
        }, { propagation: TransactionPropagation.REQUIRES_NEW });
      });

      expect(outerSession).toBeDefined();
      expect(innerSession).toBeDefined();
      expect(innerSession).not.toBe(outerSession); // Should be different sessions

      const count = await orm.em.count(Author);
      expect(count).toBe(2);
    });

    it('should isolate inner transaction failure from outer', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = new Author('outer-success', 'outer@test.com');
        await em1.persistAndFlush(entity1);

        try {
          await em1.transactional(async em2 => {
            const entity2 = new Author('inner-fail', 'inner@test.com');
            await em2.persistAndFlush(entity2);
            throw new Error('Inner transaction error');
          }, { propagation: TransactionPropagation.REQUIRES_NEW });
        } catch (e) {
          // Inner transaction should rollback
        }
      });

      // Outer transaction should commit successfully
      const authors = await orm.em.find(Author, {});
      expect(authors).toHaveLength(1);
      expect(authors[0].name).toBe('outer-success');
    });

    it('should commit inner transaction even if outer fails', async () => {
      const em = orm.em.fork();

      try {
        await em.transactional(async em1 => {
          const entity1 = new Author('outer-fail', 'outer@test.com');
          await em1.persistAndFlush(entity1);

          await em1.transactional(async em2 => {
            const entity2 = new Author('inner-success', 'inner@test.com');
            await em2.persistAndFlush(entity2);
          }, { propagation: TransactionPropagation.REQUIRES_NEW });

          throw new Error('Outer transaction error');
        });
      } catch (e) {
        // Outer transaction should rollback
      }

      // Inner REQUIRES_NEW transaction should have committed
      const authors = await orm.em.find(Author, {});
      expect(authors).toHaveLength(1);
      expect(authors[0].name).toBe('inner-success');
    });
  });

  describe('NESTED propagation', () => {
    it('should join existing transaction (MongoDB does not support savepoints)', async () => {
      const em = orm.em.fork();
      let outerSession: any;
      let innerSession: any;

      await em.transactional(async em1 => {
        outerSession = (em1 as any).transactionContext;
        const entity1 = new Author('outer', 'outer@test.com');
        await em1.persistAndFlush(entity1);

        await em1.transactional(async em2 => {
          innerSession = (em2 as any).transactionContext;
          const entity2 = new Author('inner', 'inner@test.com');
          await em2.persistAndFlush(entity2);
        }, { propagation: TransactionPropagation.NESTED });
      });

      // MongoDB doesn't support savepoints, so NESTED behaves like REQUIRED
      expect(outerSession).toBeDefined();
      expect(innerSession).toBe(outerSession);

      const count = await orm.em.count(Author);
      expect(count).toBe(2);
    });

    it('should create new transaction if none exists', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity = new Author('test', 'test@test.com');
        await em1.persistAndFlush(entity);
      }, { propagation: TransactionPropagation.NESTED });

      const count = await orm.em.count(Author);
      expect(count).toBe(1);
    });
  });

  describe('NOT_SUPPORTED propagation', () => {
    it('should execute without transaction', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = new Author('with-tx', 'with@test.com');
        await em1.persistAndFlush(entity1);

        await em1.transactional(async em2 => {
          const entity2 = new Author('without-tx', 'without@test.com');
          await em2.persistAndFlush(entity2);
        }, { propagation: TransactionPropagation.NOT_SUPPORTED });
      });

      const count = await orm.em.count(Author);
      expect(count).toBe(2);
    });

    it('should not rollback NOT_SUPPORTED operations when outer transaction fails', async () => {
      const em = orm.em.fork();

      try {
        await em.transactional(async em1 => {
          const entity1 = new Author('outer-fail', 'outer@test.com');
          await em1.persistAndFlush(entity1);

          // This should commit immediately, not part of transaction
          await em1.transactional(async em2 => {
            const entity2 = new Author('no-tx-success', 'notx@test.com');
            await em2.persistAndFlush(entity2);
          }, { propagation: TransactionPropagation.NOT_SUPPORTED });

          throw new Error('Outer transaction error');
        });
      } catch (e) {
        // Expected error
      }

      // NOT_SUPPORTED operation should have persisted
      const authors = await orm.em.find(Author, {});
      expect(authors).toHaveLength(1);
      expect(authors[0].name).toBe('no-tx-success');
    });

    it('should handle errors in NOT_SUPPORTED context independently', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = new Author('outer-success', 'outer@test.com');
        await em1.persistAndFlush(entity1);

        try {
          await em1.transactional(async em2 => {
            const entity2 = new Author('no-tx-fail', 'notx@test.com');
            await em2.persistAndFlush(entity2);
            throw new Error('NOT_SUPPORTED error');
          }, { propagation: TransactionPropagation.NOT_SUPPORTED });
        } catch (e) {
          // Error in NOT_SUPPORTED should not affect outer transaction
        }
      });

      // Since NOT_SUPPORTED runs without transaction in MongoDB,
      // the entity2 persists immediately and error doesn't rollback it
      // Outer transaction should also commit
      const authors = await orm.em.find(Author, {});
      expect(authors).toHaveLength(2);
      const names = authors.map(a => a.name).sort();
      expect(names).toEqual(['no-tx-fail', 'outer-success']);
    });
  });

  describe('No propagation specified', () => {
    it('should throw error for nested transaction without propagation', async () => {
      const em = orm.em.fork();

      await expect(em.transactional(async em1 => {
        const entity1 = new Author('outer', 'outer@test.com');
        await em1.persistAndFlush(entity1);

        // This should throw "Transaction already in progress" error
        await em1.transactional(async em2 => {
          const entity2 = new Author('inner', 'inner@test.com');
          await em2.persistAndFlush(entity2);
        });
      })).rejects.toThrow(/Transaction already in progress/);
    });
  });

  describe('Mixed propagation scenarios', () => {
    it('should handle complex nested propagation combinations', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = new Author('level1', 'level1@test.com');
        await em1.persistAndFlush(entity1);

        // REQUIRED - should join outer transaction
        await em1.transactional(async em2 => {
          const entity2 = new Author('level2-required', 'level2@test.com');
          await em2.persistAndFlush(entity2);

          // REQUIRES_NEW - should create independent transaction
          await em2.transactional(async em3 => {
            const entity3 = new Author('level3-new', 'level3@test.com');
            await em3.persistAndFlush(entity3);
          }, { propagation: TransactionPropagation.REQUIRES_NEW });
        }, { propagation: TransactionPropagation.REQUIRED });
      });

      const count = await orm.em.count(Author);
      expect(count).toBe(3);
    });

    it('should handle REQUIRED -> REQUIRES_NEW -> REQUIRED chain', async () => {
      const em = orm.em.fork();
      let outerSession: any;
      let innerNewSession: any;
      let innerRequiredSession: any;

      await em.transactional(async em1 => {
        outerSession = (em1 as any).transactionContext;
        const entity1 = new Author('outer', 'outer@test.com');
        await em1.persistAndFlush(entity1);

        await em1.transactional(async em2 => {
          innerNewSession = (em2 as any).transactionContext;
          const entity2 = new Author('inner-new', 'inner-new@test.com');
          await em2.persistAndFlush(entity2);

          await em2.transactional(async em3 => {
            innerRequiredSession = (em3 as any).transactionContext;
            const entity3 = new Author('inner-required', 'inner-required@test.com');
            await em3.persistAndFlush(entity3);
          }, { propagation: TransactionPropagation.REQUIRED });
        }, { propagation: TransactionPropagation.REQUIRES_NEW });
      }, { propagation: TransactionPropagation.REQUIRED });

      // Verify session isolation
      expect(outerSession).toBeDefined();
      expect(innerNewSession).toBeDefined();
      expect(innerRequiredSession).toBeDefined();
      expect(innerNewSession).not.toBe(outerSession);
      expect(innerRequiredSession).toBe(innerNewSession); // Should join REQUIRES_NEW session

      const count = await orm.em.count(Author);
      expect(count).toBe(3);
    });

    it('should properly isolate errors in mixed propagation', async () => {
      const em = orm.em.fork();

      try {
        await em.transactional(async em1 => {
          const entity1 = new Author('outer', 'outer@test.com');
          await em1.persistAndFlush(entity1);

          // REQUIRES_NEW - should commit independently
          await em1.transactional(async em2 => {
            const entity2 = new Author('independent', 'independent@test.com');
            await em2.persistAndFlush(entity2);
          }, { propagation: TransactionPropagation.REQUIRES_NEW });

          // REQUIRED - should rollback with outer
          await em1.transactional(async em3 => {
            const entity3 = new Author('joined', 'joined@test.com');
            await em3.persistAndFlush(entity3);
            throw new Error('Inner REQUIRED error');
          }, { propagation: TransactionPropagation.REQUIRED });
        });
      } catch (e) {
        // Expected error
      }

      // Only REQUIRES_NEW transaction should have committed
      const authors = await orm.em.find(Author, {});
      expect(authors).toHaveLength(1);
      expect(authors[0].name).toBe('independent');
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle multiple REQUIRES_NEW transactions in sequence', async () => {
      const em = orm.em.fork();
      const sessions: any[] = [];

      await em.transactional(async em1 => {
        sessions.push((em1 as any).transactionContext);

        for (let i = 0; i < 3; i++) {
          await em1.transactional(async em2 => {
            sessions.push((em2 as any).transactionContext);
            const entity = new Author(`author-${i}`, `author${i}@test.com`);
            await em2.persistAndFlush(entity);
          }, { propagation: TransactionPropagation.REQUIRES_NEW });
        }
      });

      // Each REQUIRES_NEW should have different session
      expect(sessions[0]).toBeDefined();
      expect(sessions[1]).not.toBe(sessions[0]);
      expect(sessions[2]).not.toBe(sessions[0]);
      expect(sessions[3]).not.toBe(sessions[0]);

      const count = await orm.em.count(Author);
      expect(count).toBe(3);
    });

    it('should handle deep nesting with consistent propagation', async () => {
      const em = orm.em.fork();
      const sessions: any[] = [];

      await em.transactional(async em1 => {
        sessions.push((em1 as any).transactionContext);

        await em1.transactional(async em2 => {
          sessions.push((em2 as any).transactionContext);

          await em2.transactional(async em3 => {
            sessions.push((em3 as any).transactionContext);

            await em3.transactional(async em4 => {
              sessions.push((em4 as any).transactionContext);
              const entity = new Author('deep-nested', 'deep@test.com');
              await em4.persistAndFlush(entity);
            }, { propagation: TransactionPropagation.REQUIRED });
          }, { propagation: TransactionPropagation.REQUIRED });
        }, { propagation: TransactionPropagation.REQUIRED });
      });

      // All REQUIRED should share same session
      expect(sessions.every(s => s === sessions[0])).toBe(true);

      const count = await orm.em.count(Author);
      expect(count).toBe(1);
    });

    it('should handle empty transactions correctly', async () => {
      const em = orm.em.fork();

      // Empty transaction should not cause issues
      await em.transactional(async em1 => {
        // No operations
      }, { propagation: TransactionPropagation.REQUIRED });

      await em.transactional(async em1 => {
        await em1.transactional(async em2 => {
          // No operations
        }, { propagation: TransactionPropagation.REQUIRES_NEW });
      });

      const count = await orm.em.count(Author);
      expect(count).toBe(0);
    });

    it('should maintain data consistency across propagation boundaries', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = new Author('parent', 'parent@test.com');
        await em1.persistAndFlush(entity1);

        // Verify data is visible within transaction
        const found1 = await em1.findOne(Author, { name: 'parent' });
        expect(found1).toBeDefined();

        await em1.transactional(async em2 => {
          // Should see parent data in REQUIRED
          const found2 = await em2.findOne(Author, { name: 'parent' });
          expect(found2).toBeDefined();

          const entity2 = new Author('child-required', 'child@test.com');
          await em2.persistAndFlush(entity2);
        }, { propagation: TransactionPropagation.REQUIRED });

        await em1.transactional(async em3 => {
          // REQUIRES_NEW shouldn't see uncommitted data initially
          const entity3 = new Author('child-new', 'new@test.com');
          await em3.persistAndFlush(entity3);
        }, { propagation: TransactionPropagation.REQUIRES_NEW });
      });

      const count = await orm.em.count(Author);
      expect(count).toBe(3);
    });
  });
});
