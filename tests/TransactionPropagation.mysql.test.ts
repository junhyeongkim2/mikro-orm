import { Entity, MikroORM, PrimaryKey, Property, TransactionPropagation, IsolationLevel, FlushMode } from '@mikro-orm/mysql';
import { mockLogger } from './bootstrap';

@Entity()
class TestEntity {

  @PrimaryKey()
  id!: number;

  @Property({ unique: true })
  name!: string;

  @Property({ nullable: true })
  value?: number;

}

describe('Transaction Propagation - MySQL', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      entities: [TestEntity],
      dbName: 'mikro_orm_test_propagation',
      port: 3308,
      ensureDatabase: { create: true },
    });
    await orm.schema.refreshDatabase();
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

    it('should reuse same database connection and transaction with query logging', async () => {
      const mock = mockLogger(orm, ['query']);
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        await em1.persistAndFlush(em1.create(TestEntity, { name: 'outer' }));

        await em1.transactional(async em2 => {
          await em2.persistAndFlush(em2.create(TestEntity, { name: 'inner' }));
        }, { propagation: TransactionPropagation.REQUIRED });
      });

      // Verify only one BEGIN and one COMMIT
      const beginCalls = mock.mock.calls.filter(c =>
        c[0].toLowerCase().includes('begin') || c[0].toLowerCase().includes('start transaction'),
      );
      expect(beginCalls).toHaveLength(1);

      const commitCalls = mock.mock.calls.filter(c =>
        c[0].toLowerCase().includes('commit'),
      );
      expect(commitCalls).toHaveLength(1);

      // No savepoints should be created for REQUIRED
      const savepointCalls = mock.mock.calls.filter(c =>
        c[0].toLowerCase().includes('savepoint'),
      );
      expect(savepointCalls).toHaveLength(0);
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
    it('should create new independent transaction', async () => {
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

      expect(outerTrx).toBeDefined();
      expect(innerTrx).toBeDefined();
      expect(innerTrx).not.toBe(outerTrx); // Should be different transactions

      const count = await orm.em.count(TestEntity);
      expect(count).toBe(2);
    });

    it('should use separate connections/transactions with query logging', async () => {
      const mock = mockLogger(orm, ['query']);
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        await em1.persistAndFlush(em1.create(TestEntity, { name: 'outer-tx' }));

        await em1.transactional(async em2 => {
          await em2.persistAndFlush(em2.create(TestEntity, { name: 'inner-tx' }));
        }, { propagation: TransactionPropagation.REQUIRES_NEW });

        await em1.persistAndFlush(em1.create(TestEntity, { name: 'after-inner' }));
      });

      // Should have two separate BEGIN and COMMIT pairs
      const beginCalls = mock.mock.calls.filter(c =>
        c[0].toLowerCase().includes('begin') || c[0].toLowerCase().includes('start transaction'),
      );
      expect(beginCalls).toHaveLength(2);

      const commitCalls = mock.mock.calls.filter(c =>
        c[0].toLowerCase().includes('commit'),
      );
      expect(commitCalls).toHaveLength(2);
    });

    it('should isolate inner transaction failure', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = em1.create(TestEntity, { name: 'isolate-outer' });
        await em1.persistAndFlush(entity1);

        try {
          await em1.transactional(async em2 => {
            const entity2 = em2.create(TestEntity, { name: 'isolate-inner' });
            await em2.persistAndFlush(entity2);
            throw new Error('Rollback inner');
          }, { propagation: TransactionPropagation.REQUIRES_NEW });
        } catch (e) {
          // Inner transaction rolled back
        }

        const entity3 = em1.create(TestEntity, { name: 'isolate-after' });
        await em1.persistAndFlush(entity3);
      });

      const entities = await orm.em.find(TestEntity, {});
      expect(entities).toHaveLength(2);
      expect(entities.map(e => e.name)).toEqual(expect.arrayContaining(['isolate-outer', 'isolate-after']));
    });

    it('should commit inner transaction even if outer fails', async () => {
      const em = orm.em.fork();

      try {
        await em.transactional(async em1 => {
          const entity1 = em1.create(TestEntity, { name: 'outer-fail' });
          await em1.persistAndFlush(entity1);

          await em1.transactional(async em2 => {
            const entity2 = em2.create(TestEntity, { name: 'inner-success' });
            await em2.persistAndFlush(entity2);
          }, { propagation: TransactionPropagation.REQUIRES_NEW });

          throw new Error('Outer transaction error');
        });
      } catch (e) {
        // Outer transaction should rollback
      }

      // Inner REQUIRES_NEW transaction should have committed
      const entities = await orm.em.find(TestEntity, {});
      expect(entities).toHaveLength(1);
      expect(entities[0].name).toBe('inner-success');
    });

    it('should handle multiple REQUIRES_NEW transactions in parallel', async () => {
      const em = orm.em.fork();
      const contexts: any[] = [];

      await em.transactional(async em1 => {
        contexts.push((em1 as any).transactionContext);

        for (let i = 0; i < 3; i++) {
          await em1.transactional(async em2 => {
            contexts.push((em2 as any).transactionContext);
            const entity = em2.create(TestEntity, { name: `entity-${i}` });
            await em2.persistAndFlush(entity);
          }, { propagation: TransactionPropagation.REQUIRES_NEW });
        }
      });

      // Each REQUIRES_NEW should have different context
      expect(contexts[0]).toBeDefined();
      for (let i = 1; i < contexts.length; i++) {
        expect(contexts[i]).not.toBe(contexts[0]);
      }

      const count = await orm.em.count(TestEntity);
      expect(count).toBe(3);
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
          // Inner transaction rolled back to savepoint
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

    it('should create and use savepoints with query logging', async () => {
      const mock = mockLogger(orm, ['query']);
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        await em1.persistAndFlush(em1.create(TestEntity, { name: 'outer' }));

        await em1.transactional(async em2 => {
          await em2.persistAndFlush(em2.create(TestEntity, { name: 'nested' }));
        }, { propagation: TransactionPropagation.NESTED });
      });

      // Verify savepoint creation
      const savepointCalls = mock.mock.calls.filter(c =>
        c[0].toLowerCase().includes('savepoint'),
      );
      expect(savepointCalls.length).toBeGreaterThan(0);

      // Check savepoint naming pattern
      const savepointCreate = savepointCalls.find(c =>
        !c[0].toLowerCase().includes('release') && !c[0].toLowerCase().includes('rollback'),
      );
      expect(savepointCreate).toBeDefined();
      expect(savepointCreate![0]).toMatch(/savepoint/i);
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

      await em.transactional(async em1 => {
        const entity1 = em1.create(TestEntity, { name: 'with-tx' });
        await em1.persistAndFlush(entity1);

        await em1.transactional(async em2 => {
          const entity2 = em2.create(TestEntity, { name: 'without-tx' });
          await em2.persistAndFlush(entity2);
        }, { propagation: TransactionPropagation.NOT_SUPPORTED });
      });

      const count = await orm.em.count(TestEntity);
      expect(count).toBe(2);
    });

    it('should not rollback NOT_SUPPORTED operations when outer fails', async () => {
      const em = orm.em.fork();

      try {
        await em.transactional(async em1 => {
          const entity1 = em1.create(TestEntity, { name: 'outer-fail' });
          await em1.persistAndFlush(entity1);

          // This should commit immediately, not part of transaction
          await em1.transactional(async em2 => {
            const entity2 = em2.create(TestEntity, { name: 'no-tx-success' });
            await em2.persistAndFlush(entity2);
          }, { propagation: TransactionPropagation.NOT_SUPPORTED });

          throw new Error('Outer transaction error');
        });
      } catch (e) {
        // Expected error
      }

      // NOT_SUPPORTED operation should have persisted
      const entities = await orm.em.find(TestEntity, {});
      expect(entities).toHaveLength(1);
      expect(entities[0].name).toBe('no-tx-success');
    });

    it('should handle errors in NOT_SUPPORTED independently', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = em1.create(TestEntity, { name: 'outer-success' });
        await em1.persistAndFlush(entity1);

        try {
          await em1.transactional(async em2 => {
            const entity2 = em2.create(TestEntity, { name: 'no-tx-fail' });
            await em2.persistAndFlush(entity2);
            throw new Error('NOT_SUPPORTED error');
          }, { propagation: TransactionPropagation.NOT_SUPPORTED });
        } catch (e) {
          // Error in NOT_SUPPORTED should not affect outer transaction
        }
      });

      // Both should be persisted (NOT_SUPPORTED commits immediately)
      const entities = await orm.em.find(TestEntity, {});
      expect(entities).toHaveLength(2);
      const names = entities.map(e => e.name).sort();
      expect(names).toEqual(['no-tx-fail', 'outer-success']);
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

    it('should properly isolate errors in mixed propagation', async () => {
      const em = orm.em.fork();

      try {
        await em.transactional(async em1 => {
          const entity1 = em1.create(TestEntity, { name: 'outer' });
          await em1.persistAndFlush(entity1);

          // REQUIRES_NEW - should commit independently
          await em1.transactional(async em2 => {
            const entity2 = em2.create(TestEntity, { name: 'independent' });
            await em2.persistAndFlush(entity2);
          }, { propagation: TransactionPropagation.REQUIRES_NEW });

          // NESTED - will create savepoint but still fail with outer
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

      // Only REQUIRES_NEW transaction should have committed
      const entities = await orm.em.find(TestEntity, {});
      expect(entities).toHaveLength(1);
      expect(entities[0].name).toBe('independent');
    });

    it('should handle REQUIRED -> NESTED -> REQUIRES_NEW chain', async () => {
      const em = orm.em.fork();
      const contexts: any[] = [];

      await em.transactional(async em1 => {
        contexts.push((em1 as any).transactionContext);
        const entity1 = em1.create(TestEntity, { name: 'required' });
        await em1.persistAndFlush(entity1);

        await em1.transactional(async em2 => {
          contexts.push((em2 as any).transactionContext);
          const entity2 = em2.create(TestEntity, { name: 'nested' });
          await em2.persistAndFlush(entity2);

          await em2.transactional(async em3 => {
            contexts.push((em3 as any).transactionContext);
            const entity3 = em3.create(TestEntity, { name: 'requires-new' });
            await em3.persistAndFlush(entity3);
          }, { propagation: TransactionPropagation.REQUIRES_NEW });
        }, { propagation: TransactionPropagation.NESTED });
      }, { propagation: TransactionPropagation.REQUIRED });

      // NESTED creates a savepoint which may have a different context object
      // but it's still part of the same transaction
      expect(contexts[0]).toBeDefined();
      expect(contexts[1]).toBeDefined(); // NESTED may have different context for savepoint
      expect(contexts[2]).toBeDefined();
      expect(contexts[2]).not.toBe(contexts[0]); // REQUIRES_NEW is definitely different
      expect(contexts[2]).not.toBe(contexts[1]); // REQUIRES_NEW is different from NESTED too

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
            const entity3 = em3.create(TestEntity, { name: 'level3-new' });
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
          // REQUIRES_NEW has its own transaction, may not see uncommitted data
          const entity4 = em4.create(TestEntity, { name: 'child-new' });
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
    describe('Isolation Levels', () => {
      it('should use specified isolation level', async () => {
        const em = orm.em.fork();

        await em.transactional(async em1 => {
          const entity = em1.create(TestEntity, { name: 'isolated' });
          await em1.persistAndFlush(entity);
        }, {
          propagation: TransactionPropagation.REQUIRED,
          isolationLevel: IsolationLevel.SERIALIZABLE,
        });

        const count = await orm.em.count(TestEntity);
        expect(count).toBe(1);
      });

      it('should maintain separate isolation levels for REQUIRES_NEW', async () => {
        const em = orm.em.fork();

        await em.transactional(async em1 => {
          await em1.transactional(async em2 => {
            const entity = em2.create(TestEntity, { name: 'inner-isolated' });
            await em2.persistAndFlush(entity);
          }, {
            propagation: TransactionPropagation.REQUIRES_NEW,
            isolationLevel: IsolationLevel.READ_UNCOMMITTED,
          });
        }, {
          isolationLevel: IsolationLevel.SERIALIZABLE,
        });

        const count = await orm.em.count(TestEntity);
        expect(count).toBe(1);
      });
    });

    describe('Flush Modes', () => {
      it('should respect flush mode settings', async () => {
        const em = orm.em.fork();

        await em.transactional(async em1 => {
          const entity = em1.create(TestEntity, { name: 'test-flush' });
          em1.persist(entity);

          await em1.transactional(async () => {
            entity.name = 'changed';
          }, {
            propagation: TransactionPropagation.NESTED,
            flushMode: FlushMode.COMMIT,
          });

          await em1.flush();
        });

        const entities = await orm.em.find(TestEntity, {});
        expect(entities[0].name).toBe('changed');
      });
    });

    describe('Concurrent Transactions', () => {
      it('should handle multiple REQUIRES_NEW transactions in parallel', async () => {
        const em = orm.em.fork();

        await em.transactional(async em1 => {
          await em1.persistAndFlush(em1.create(TestEntity, { name: 'main' }));

          const promises = Array.from({ length: 3 }, (_, i) =>
            em1.transactional(async em2 => {
              const entity = em2.create(TestEntity, { name: `parallel-${i}` });
              await em2.persistAndFlush(entity);
              return entity.id;
            }, { propagation: TransactionPropagation.REQUIRES_NEW }),
          );

          const results = await Promise.all(promises);
          expect(results).toHaveLength(3);
          expect(new Set(results).size).toBe(3);
        });

        const count = await orm.em.count(TestEntity);
        expect(count).toBe(4);
      });

      it('should isolate REQUIRES_NEW failure from outer transaction', async () => {
        const em = orm.em.fork();

        await em.transactional(async em1 => {
          await em1.persistAndFlush(em1.create(TestEntity, { name: 'outer-before' }));

          try {
            await em1.transactional(async em2 => {
              await em2.persistAndFlush(em2.create(TestEntity, { name: 'inner-fail' }));
              throw new Error('Inner transaction failed');
            }, { propagation: TransactionPropagation.REQUIRES_NEW });
          } catch (e) {
            // Inner transaction rolled back independently
          }

          await em1.persistAndFlush(em1.create(TestEntity, { name: 'outer-after' }));
        });

        const entities = await orm.em.find(TestEntity, {});
        expect(entities.map(e => e.name).sort()).toEqual(['outer-after', 'outer-before']);
      });
    });
  });
});
