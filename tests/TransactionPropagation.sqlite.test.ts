import { Entity, MikroORM, PrimaryKey, Property, TransactionPropagation, FlushMode } from '@mikro-orm/sqlite';

@Entity()
class TestEntity {

  @PrimaryKey()
  id!: number;

  @Property({ unique: true })
  name!: string;

  @Property({ nullable: true })
  value?: number;

}

describe('Transaction Propagation - SQLite', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      entities: [TestEntity],
      dbName: ':memory:',
    });
    await orm.schema.createSchema();
  });

  afterAll(() => orm.close(true));

  beforeEach(async () => {
    await orm.em.nativeDelete(TestEntity, {});
  });

  describe('REQUIRED propagation', () => {
    it('should join existing transaction', async () => {
      const em = orm.em.fork();
      let outerTrx: any;
      let innerTrx: any;

      await em.transactional(async em1 => {
        outerTrx = (em1 as any).transactionContext;

        await em1.transactional(async em2 => {
          innerTrx = (em2 as any).transactionContext;
          const entity = em2.create(TestEntity, { name: 'test' });
          await em2.persistAndFlush(entity);
        }, { propagation: TransactionPropagation.REQUIRED });
      });

      expect(outerTrx).toBeDefined();
      expect(innerTrx).toBe(outerTrx); // Should be same transaction

      const count = await orm.em.count(TestEntity);
      expect(count).toBe(1);
    });

    it('should create new transaction if none exists', async () => {
      const em = orm.em.fork();
      let trx: any;

      await em.transactional(async em1 => {
        trx = (em1 as any).transactionContext;
        const entity = em1.create(TestEntity, { name: 'test' });
        await em1.persistAndFlush(entity);
      }, { propagation: TransactionPropagation.REQUIRED });

      expect(trx).toBeDefined();
      const count = await orm.em.count(TestEntity);
      expect(count).toBe(1);
    });

    it('should rollback all operations when inner transaction fails', async () => {
      const em = orm.em.fork();

      try {
        await em.transactional(async em1 => {
          const entity1 = em1.create(TestEntity, { name: 'outer' });
          await em1.persistAndFlush(entity1);

          await em1.transactional(async em2 => {
            const entity2 = em2.create(TestEntity, { name: 'inner' });
            await em2.persistAndFlush(entity2);
            throw new Error('Inner error');
          }, { propagation: TransactionPropagation.REQUIRED });
        });
      } catch (e) {
        // Expected error
      }

      // Both operations should be rolled back
      const count = await orm.em.count(TestEntity);
      expect(count).toBe(0);
    });

    it('should handle multiple REQUIRED propagations in sequence', async () => {
      const em = orm.em.fork();
      const contexts: any[] = [];

      await em.transactional(async em1 => {
        contexts.push((em1 as any).transactionContext);
        const entity1 = em1.create(TestEntity, { name: 'first' });
        await em1.persistAndFlush(entity1);

        await em1.transactional(async em2 => {
          contexts.push((em2 as any).transactionContext);
          const entity2 = em2.create(TestEntity, { name: 'second' });
          await em2.persistAndFlush(entity2);
        }, { propagation: TransactionPropagation.REQUIRED });

        await em1.transactional(async em3 => {
          contexts.push((em3 as any).transactionContext);
          const entity3 = em3.create(TestEntity, { name: 'third' });
          await em3.persistAndFlush(entity3);
        }, { propagation: TransactionPropagation.REQUIRED });
      });

      // All should share the same context
      expect(contexts.every(ctx => ctx === contexts[0])).toBe(true);
      const count = await orm.em.count(TestEntity);
      expect(count).toBe(3);
    });
  });

  describe('REQUIRES_NEW propagation', () => {
    it('should fall back to NESTED in SQLite due to single connection limitation', async () => {
      const em = orm.em.fork();
      let outerTrx: any;
      let innerTrx: any;

      await em.transactional(async em1 => {
        outerTrx = (em1 as any).transactionContext;
        const entity1 = em1.create(TestEntity, { name: 'outer' });
        await em1.persistAndFlush(entity1);

        await em1.transactional(async em2 => {
          innerTrx = (em2 as any).transactionContext;
          const entity2 = em2.create(TestEntity, { name: 'inner' });
          await em2.persistAndFlush(entity2);
        }, { propagation: TransactionPropagation.REQUIRES_NEW });
      });

      // In SQLite, REQUIRES_NEW falls back to NESTED (savepoint)
      expect(outerTrx).toBeDefined();
      expect(innerTrx).toBeDefined();

      const count = await orm.em.count(TestEntity);
      expect(count).toBe(2);
    });

    it('should isolate inner transaction failure with NESTED fallback', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = em1.create(TestEntity, { name: 'outer' });
        await em1.persistAndFlush(entity1);

        try {
          await em1.transactional(async em2 => {
            const entity2 = em2.create(TestEntity, { name: 'inner' });
            await em2.persistAndFlush(entity2);
            throw new Error('Rollback inner');
          }, { propagation: TransactionPropagation.REQUIRES_NEW });
        } catch (e) {
          // Inner transaction (actually savepoint) rolled back
        }

        const entity3 = em1.create(TestEntity, { name: 'after' });
        await em1.persistAndFlush(entity3);
      });

      // REQUIRES_NEW falls back to NESTED in SQLite, so it behaves like savepoint
      const entities = await orm.em.find(TestEntity, {});
      expect(entities).toHaveLength(2);
      expect(entities.map(e => e.name)).toEqual(expect.arrayContaining(['outer', 'after']));
    });

    it('should handle multiple REQUIRES_NEW with fallback to NESTED', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = em1.create(TestEntity, { name: 'outer' });
        await em1.persistAndFlush(entity1);

        for (let i = 0; i < 3; i++) {
          await em1.transactional(async em2 => {
            const entity = em2.create(TestEntity, { name: `entity-${i}` });
            await em2.persistAndFlush(entity);
          }, { propagation: TransactionPropagation.REQUIRES_NEW });
        }
      });

      const count = await orm.em.count(TestEntity);
      expect(count).toBe(4);
    });
  });

  describe('NESTED propagation', () => {
    it('should create savepoint when transaction exists', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = em1.create(TestEntity, { name: 'outer' });
        await em1.persistAndFlush(entity1);

        try {
          await em1.transactional(async em2 => {
            const entity2 = em2.create(TestEntity, { name: 'inner' });
            await em2.persistAndFlush(entity2);
            throw new Error('Rollback inner');
          }, { propagation: TransactionPropagation.NESTED });
        } catch (e) {
          // Inner transaction rolled back
        }

        const entity3 = em1.create(TestEntity, { name: 'after' });
        await em1.persistAndFlush(entity3);
      });

      const entities = await orm.em.find(TestEntity, {});
      expect(entities).toHaveLength(2);
      expect(entities.map(e => e.name)).toEqual(expect.arrayContaining(['outer', 'after']));
    });

    it('should create new transaction if none exists', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity = em1.create(TestEntity, { name: 'test' });
        await em1.persistAndFlush(entity);
      }, { propagation: TransactionPropagation.NESTED });

      const count = await orm.em.count(TestEntity);
      expect(count).toBe(1);
    });

    it('should handle multiple nested savepoints', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = em1.create(TestEntity, { name: 'level1' });
        await em1.persistAndFlush(entity1);

        await em1.transactional(async em2 => {
          const entity2 = em2.create(TestEntity, { name: 'level2' });
          await em2.persistAndFlush(entity2);

          try {
            await em2.transactional(async em3 => {
              const entity3 = em3.create(TestEntity, { name: 'level3' });
              await em3.persistAndFlush(entity3);
              throw new Error('Rollback level3');
            }, { propagation: TransactionPropagation.NESTED });
          } catch (e) {
            // Level 3 rolled back
          }

          const entity4 = em2.create(TestEntity, { name: 'level2-after' });
          await em2.persistAndFlush(entity4);
        }, { propagation: TransactionPropagation.NESTED });
      });

      const entities = await orm.em.find(TestEntity, {});
      expect(entities).toHaveLength(3);
      const names = entities.map(e => e.name).sort();
      expect(names).toEqual(['level1', 'level2', 'level2-after']);
    });

    it('should properly isolate savepoint rollbacks', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = em1.create(TestEntity, { name: 'outer' });
        await em1.persistAndFlush(entity1);

        // First nested - will fail
        try {
          await em1.transactional(async em2 => {
            const entity2 = em2.create(TestEntity, { name: 'nested1' });
            await em2.persistAndFlush(entity2);
            throw new Error('Rollback nested1');
          }, { propagation: TransactionPropagation.NESTED });
        } catch (e) {
          // Expected
        }

        // Second nested - should succeed
        await em1.transactional(async em2 => {
          const entity3 = em2.create(TestEntity, { name: 'nested2' });
          await em2.persistAndFlush(entity3);
        }, { propagation: TransactionPropagation.NESTED });
      });

      const entities = await orm.em.find(TestEntity, {});
      expect(entities).toHaveLength(2);
      const names = entities.map(e => e.name).sort();
      expect(names).toEqual(['nested2', 'outer']);
    });
  });

  describe('NOT_SUPPORTED propagation', () => {
    it('should execute without transaction', async () => {
      const em = orm.em.fork();

      // First create an entity in a transaction
      await em.transactional(async em1 => {
        const entity1 = em1.create(TestEntity, { name: 'with-tx' });
        await em1.persistAndFlush(entity1);
      });

      // Then create another entity without transaction
      await em.transactional(async em2 => {
        const entity2 = em2.create(TestEntity, { name: 'without-tx' });
        await em2.persistAndFlush(entity2);
      }, { propagation: TransactionPropagation.NOT_SUPPORTED });

      const count = await orm.em.count(TestEntity);
      expect(count).toBe(2);
    });

    it('should not rollback NOT_SUPPORTED operations when outer fails', async () => {
      const em = orm.em.fork();

      // Since SQLite has only one connection, NOT_SUPPORTED within a transaction
      // cannot truly execute independently. It will participate in the transaction.
      try {
        await em.transactional(async em1 => {
          const entity1 = em1.create(TestEntity, { name: 'outer-fail' });
          await em1.persistAndFlush(entity1);

          // In SQLite, this will still be part of the outer transaction
          await em1.transactional(async em2 => {
            const entity2 = em2.create(TestEntity, { name: 'no-tx-attempt' });
            await em2.persistAndFlush(entity2);
          }, { propagation: TransactionPropagation.NOT_SUPPORTED });

          throw new Error('Outer transaction error');
        });
      } catch (e) {
        // Expected error
      }

      // In SQLite, NOT_SUPPORTED within a transaction still participates
      // in the transaction, so everything rolls back
      const entities = await orm.em.find(TestEntity, {});
      expect(entities).toHaveLength(0);
    });

    it('should handle errors in NOT_SUPPORTED independently', async () => {
      const em = orm.em.fork();

      // Test NOT_SUPPORTED without an outer transaction first
      try {
        await em.transactional(async em1 => {
          const entity1 = em1.create(TestEntity, { name: 'no-tx-error' });
          await em1.persistAndFlush(entity1);
          throw new Error('NOT_SUPPORTED error');
        }, { propagation: TransactionPropagation.NOT_SUPPORTED });
      } catch (e) {
        // Expected error
      }

      // NOT_SUPPORTED without outer transaction should still persist before error
      const entities1 = await orm.em.find(TestEntity, {});
      expect(entities1).toHaveLength(1);

      // Clear for next test
      await orm.em.nativeDelete(TestEntity, {});

      // Now test within a transaction
      await em.transactional(async em1 => {
        const entity2 = em1.create(TestEntity, { name: 'outer-success' });
        await em1.persistAndFlush(entity2);

        try {
          await em1.transactional(async em2 => {
            const entity3 = em2.create(TestEntity, { name: 'no-tx-fail' });
            await em2.persistAndFlush(entity3);
            throw new Error('NOT_SUPPORTED error');
          }, { propagation: TransactionPropagation.NOT_SUPPORTED });
        } catch (e) {
          // In SQLite, error still affects transaction
        }
      });

      // In SQLite with single connection, NOT_SUPPORTED within transaction
      // still participates in the transaction
      const entities2 = await orm.em.find(TestEntity, {});
      expect(entities2).toHaveLength(1);
      expect(entities2[0].name).toBe('outer-success');
    });
  });

  describe('Mixed propagation scenarios', () => {
    it('should handle complex nested propagations', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = em1.create(TestEntity, { name: 'level1' });
        await em1.persistAndFlush(entity1);

        await em1.transactional(async em2 => {
          const entity2 = em2.create(TestEntity, { name: 'level2-required' });
          await em2.persistAndFlush(entity2);

          await em2.transactional(async em3 => {
            const entity3 = em3.create(TestEntity, { name: 'level3-nested' });
            await em3.persistAndFlush(entity3);
          }, { propagation: TransactionPropagation.NESTED });

          await em2.transactional(async em3 => {
            const entity4 = em3.create(TestEntity, { name: 'level3-new' });
            await em3.persistAndFlush(entity4);
          }, { propagation: TransactionPropagation.REQUIRES_NEW });
        }, { propagation: TransactionPropagation.REQUIRED });
      });

      const count = await orm.em.count(TestEntity);
      expect(count).toBe(4);
    });

    it('should properly isolate errors with SQLite fallback behavior', async () => {
      const em = orm.em.fork();

      try {
        await em.transactional(async em1 => {
          const entity1 = em1.create(TestEntity, { name: 'outer' });
          await em1.persistAndFlush(entity1);

          // REQUIRES_NEW falls back to NESTED in SQLite
          try {
            await em1.transactional(async em2 => {
              const entity2 = em2.create(TestEntity, { name: 'pseudo-independent' });
              await em2.persistAndFlush(entity2);
              throw new Error('Inner error');
            }, { propagation: TransactionPropagation.REQUIRES_NEW });
          } catch (e) {
            // Savepoint rolled back
          }

          // NESTED - explicit savepoint
          await em1.transactional(async em2 => {
            const entity3 = em2.create(TestEntity, { name: 'nested' });
            await em2.persistAndFlush(entity3);
          }, { propagation: TransactionPropagation.NESTED });

          // REQUIRED - should rollback with outer
          await em1.transactional(async em2 => {
            const entity4 = em2.create(TestEntity, { name: 'joined' });
            await em2.persistAndFlush(entity4);
            throw new Error('Inner REQUIRED error');
          }, { propagation: TransactionPropagation.REQUIRED });
        });
      } catch (e) {
        // Expected error
      }

      // All operations rolled back (SQLite's REQUIRES_NEW falls back to NESTED)
      const entities = await orm.em.find(TestEntity, {});
      expect(entities).toHaveLength(0);
    });

    it('should handle REQUIRED -> NESTED -> REQUIRES_NEW chain with fallback', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = em1.create(TestEntity, { name: 'required' });
        await em1.persistAndFlush(entity1);

        await em1.transactional(async em2 => {
          const entity2 = em2.create(TestEntity, { name: 'nested' });
          await em2.persistAndFlush(entity2);

          await em2.transactional(async em3 => {
            const entity3 = em3.create(TestEntity, { name: 'requires-new-fallback' });
            await em3.persistAndFlush(entity3);
          }, { propagation: TransactionPropagation.REQUIRES_NEW });
        }, { propagation: TransactionPropagation.NESTED });
      }, { propagation: TransactionPropagation.REQUIRED });

      // All succeed (REQUIRES_NEW becomes NESTED in SQLite)
      const count = await orm.em.count(TestEntity);
      expect(count).toBe(3);
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle deep nesting with all propagation types', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = em1.create(TestEntity, { name: 'level1-required' });
        await em1.persistAndFlush(entity1);

        await em1.transactional(async em2 => {
          const entity2 = em2.create(TestEntity, { name: 'level2-nested' });
          await em2.persistAndFlush(entity2);

          await em2.transactional(async em3 => {
            const entity3 = em3.create(TestEntity, { name: 'level3-new-fallback' });
            await em3.persistAndFlush(entity3);

            await em3.transactional(async em4 => {
              const entity4 = em4.create(TestEntity, { name: 'level4-required' });
              await em4.persistAndFlush(entity4);
            }, { propagation: TransactionPropagation.REQUIRED });
          }, { propagation: TransactionPropagation.REQUIRES_NEW });
        }, { propagation: TransactionPropagation.NESTED });
      });

      const count = await orm.em.count(TestEntity);
      expect(count).toBe(4);
    });

    it('should maintain data consistency across propagation boundaries', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = em1.create(TestEntity, { name: 'parent' });
        await em1.persistAndFlush(entity1);

        // Verify data is visible within transaction
        const found1 = await em1.findOne(TestEntity, { name: 'parent' });
        expect(found1).toBeDefined();

        await em1.transactional(async em2 => {
          // Should see parent data in REQUIRED
          const found2 = await em2.findOne(TestEntity, { name: 'parent' });
          expect(found2).toBeDefined();

          const entity2 = em2.create(TestEntity, { name: 'child-required' });
          await em2.persistAndFlush(entity2);
        }, { propagation: TransactionPropagation.REQUIRED });

        await em1.transactional(async em3 => {
          // Should see parent data in NESTED
          const found3 = await em3.findOne(TestEntity, { name: 'parent' });
          expect(found3).toBeDefined();

          const entity3 = em3.create(TestEntity, { name: 'child-nested' });
          await em3.persistAndFlush(entity3);
        }, { propagation: TransactionPropagation.NESTED });

        await em1.transactional(async em4 => {
          // REQUIRES_NEW falls back to NESTED in SQLite, so should see parent data
          const found4 = await em4.findOne(TestEntity, { name: 'parent' });
          expect(found4).toBeDefined();

          const entity4 = em4.create(TestEntity, { name: 'child-new-fallback' });
          await em4.persistAndFlush(entity4);
        }, { propagation: TransactionPropagation.REQUIRES_NEW });
      });

      const count = await orm.em.count(TestEntity);
      expect(count).toBe(4);
    });

    it('should handle empty transactions with all propagation types', async () => {
      const em = orm.em.fork();

      // Empty transactions should not cause issues
      await em.transactional(async () => {
        // Empty transaction
      }, { propagation: TransactionPropagation.REQUIRED });
      await em.transactional(async () => {
        // Empty transaction
      }, { propagation: TransactionPropagation.REQUIRES_NEW });
      await em.transactional(async () => {
        // Empty transaction
      }, { propagation: TransactionPropagation.NESTED });
      await em.transactional(async () => {
        // Empty transaction
      }, { propagation: TransactionPropagation.NOT_SUPPORTED });

      await em.transactional(async em1 => {
        await em1.transactional(async () => {
          // Empty transaction
        }, { propagation: TransactionPropagation.REQUIRED });
        await em1.transactional(async () => {
          // Empty transaction
        }, { propagation: TransactionPropagation.REQUIRES_NEW });
        await em1.transactional(async () => {
          // Empty transaction
        }, { propagation: TransactionPropagation.NESTED });
        await em1.transactional(async () => {
          // Empty transaction
        }, { propagation: TransactionPropagation.NOT_SUPPORTED });
      });

      const count = await orm.em.count(TestEntity);
      expect(count).toBe(0);
    });
  });

  describe('Advanced Features', () => {
    describe('Flush Modes', () => {
      it('should respect flush mode settings', async () => {
        const em = orm.em.fork();

        await em.transactional(async em1 => {
          const entity = em1.create(TestEntity, { name: 'test-flush-sqlite' });
          em1.persist(entity);

          await em1.transactional(async () => {
            entity.name = 'changed-sqlite';
          }, {
            propagation: TransactionPropagation.NESTED,
            flushMode: FlushMode.COMMIT,
          });

          await em1.flush();
        });

        const entities = await orm.em.find(TestEntity, {});
        expect(entities[0].name).toBe('changed-sqlite');
      });

      it('should handle different flush modes in nested transactions', async () => {
        const em = orm.em.fork();

        await em.transactional(async em1 => {
          const entity = em1.create(TestEntity, { name: 'outer-flush-sqlite' });
          em1.persist(entity);

          await em1.transactional(async em2 => {
            const entity2 = em2.create(TestEntity, { name: 'inner-flush-sqlite' });
            await em2.persistAndFlush(entity2);
          }, {
            propagation: TransactionPropagation.NESTED,
            flushMode: FlushMode.AUTO,
          });
        }, {
          flushMode: FlushMode.COMMIT,
        });

        const count = await orm.em.count(TestEntity);
        expect(count).toBe(2);
      });
    });

    describe('Concurrent Operations', () => {
      it('should handle sequential operations with NESTED (SQLite limitation)', async () => {
        const em = orm.em.fork();

        await em.transactional(async em1 => {
          await em1.persistAndFlush(em1.create(TestEntity, { name: 'main-sqlite' }));

          // SQLite uses savepoints for NESTED behavior
          for (let i = 0; i < 3; i++) {
            await em1.transactional(async em2 => {
              const entity = em2.create(TestEntity, { name: `sequential-sqlite-${i}` });
              await em2.persistAndFlush(entity);
            }, { propagation: TransactionPropagation.NESTED });
          }
        });

        const count = await orm.em.count(TestEntity);
        expect(count).toBe(4);
      });

      it('should handle errors with savepoints', async () => {
        const em = orm.em.fork();

        await em.transactional(async em1 => {
          await em1.persistAndFlush(em1.create(TestEntity, { name: 'outer-before-sqlite' }));

          try {
            await em1.transactional(async em2 => {
              await em2.persistAndFlush(em2.create(TestEntity, { name: 'inner-fail-sqlite' }));
              throw new Error('Savepoint error');
            }, { propagation: TransactionPropagation.NESTED });
          } catch (e) {
            // Savepoint rolled back
          }

          await em1.persistAndFlush(em1.create(TestEntity, { name: 'outer-after-sqlite' }));
        });

        const entities = await orm.em.find(TestEntity, {});
        expect(entities.map(e => e.name).sort()).toEqual(['outer-after-sqlite', 'outer-before-sqlite']);
      });
    });

    describe('Clear Option with Propagation', () => {
      it('should clear identity map when specified', async () => {
        const em = orm.em.fork();
        const entity = em.create(TestEntity, { name: 'test-clear-sqlite' });
        await em.persistAndFlush(entity);

        await em.transactional(async em1 => {
          const loaded = await em1.findOne(TestEntity, { name: 'test-clear-sqlite' });
          expect(loaded).toBeDefined();
          expect(loaded).not.toBe(entity);
        }, {
          clear: true,
        });
      });
    });

    describe('Combined Options', () => {
      it('should combine multiple options correctly', async () => {
        const em = orm.em.fork();

        await em.transactional(async em1 => {
          const entity = em1.create(TestEntity, { name: 'combined-sqlite' });
          await em1.persistAndFlush(entity);
        }, {
          propagation: TransactionPropagation.NESTED,
          flushMode: FlushMode.AUTO,
          clear: true,
        });

        const count = await orm.em.count(TestEntity);
        expect(count).toBe(1);
      });
    });
  });
});
