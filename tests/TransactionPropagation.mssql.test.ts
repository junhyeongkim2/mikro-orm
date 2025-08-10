import { Entity, MikroORM, PrimaryKey, Property, TransactionPropagation, IsolationLevel, FlushMode } from '@mikro-orm/mssql';
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

describe('Transaction Propagation - MSSQL', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      entities: [TestEntity],
      dbName: 'mikro_orm_test_propagation',
      password: 'Root.Root',
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
        c[0].toLowerCase().includes('begin'),
      );
      expect(beginCalls).toHaveLength(1);

      const commitCalls = mock.mock.calls.filter(c =>
        c[0].toLowerCase().includes('commit'),
      );
      expect(commitCalls).toHaveLength(1);
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
        c[0].toLowerCase().includes('begin'),
      );
      expect(beginCalls).toHaveLength(2);

      const commitCalls = mock.mock.calls.filter(c =>
        c[0].toLowerCase().includes('commit'),
      );
      expect(commitCalls).toHaveLength(2);
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

    it('should create and use savepoints with query logging', async () => {
      const mock = mockLogger(orm, ['query']);
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        await em1.persistAndFlush(em1.create(TestEntity, { name: 'outer' }));

        await em1.transactional(async em2 => {
          await em2.persistAndFlush(em2.create(TestEntity, { name: 'nested' }));
        }, { propagation: TransactionPropagation.NESTED });
      });

      // Verify savepoint creation (MSSQL uses SAVE TRANSACTION)
      const savepointCalls = mock.mock.calls.filter(c =>
        c[0].toLowerCase().includes('save transaction') ||
        c[0].toLowerCase().includes('savepoint'),
      );
      expect(savepointCalls.length).toBeGreaterThan(0);
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
  });

  describe('Mixed propagation scenarios', () => {
    it('should handle complex nested propagations', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = em1.create(TestEntity, { name: 'level1-mssql' });
        await em1.persistAndFlush(entity1);

        await em1.transactional(async em2 => {
          const entity2 = em2.create(TestEntity, { name: 'level2-required-mssql' });
          await em2.persistAndFlush(entity2);

          await em2.transactional(async em3 => {
            const entity3 = em3.create(TestEntity, { name: 'level3-nested-mssql' });
            await em3.persistAndFlush(entity3);
          }, { propagation: TransactionPropagation.NESTED });

          await em2.transactional(async em3 => {
            const entity4 = em3.create(TestEntity, { name: 'level3-new-mssql' });
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
          const entity1 = em1.create(TestEntity, { name: 'outer-mixed-mssql' });
          await em1.persistAndFlush(entity1);

          // REQUIRES_NEW - should commit independently
          await em1.transactional(async em2 => {
            const entity2 = em2.create(TestEntity, { name: 'independent-mssql' });
            await em2.persistAndFlush(entity2);
          }, { propagation: TransactionPropagation.REQUIRES_NEW });

          // NESTED - will create savepoint but still fail with outer
          await em1.transactional(async em2 => {
            const entity3 = em2.create(TestEntity, { name: 'nested-mssql' });
            await em2.persistAndFlush(entity3);
          }, { propagation: TransactionPropagation.NESTED });

          // REQUIRED - should rollback with outer
          await em1.transactional(async em2 => {
            const entity4 = em2.create(TestEntity, { name: 'joined-mssql' });
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
      expect(entities[0].name).toBe('independent-mssql');
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle deep nesting with all propagation types', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = em1.create(TestEntity, { name: 'level1-required-mssql' });
        await em1.persistAndFlush(entity1);

        await em1.transactional(async em2 => {
          const entity2 = em2.create(TestEntity, { name: 'level2-nested-mssql' });
          await em2.persistAndFlush(entity2);

          await em2.transactional(async em3 => {
            const entity3 = em3.create(TestEntity, { name: 'level3-new-mssql' });
            await em3.persistAndFlush(entity3);

            await em3.transactional(async em4 => {
              const entity4 = em4.create(TestEntity, { name: 'level4-required-mssql' });
              await em4.persistAndFlush(entity4);
            }, { propagation: TransactionPropagation.REQUIRED });
          }, { propagation: TransactionPropagation.REQUIRES_NEW });
        }, { propagation: TransactionPropagation.NESTED });
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
          const entity = em1.create(TestEntity, { name: 'isolated-mssql' });
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
            const entity = em2.create(TestEntity, { name: 'inner-isolated-mssql' });
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
          const entity = em1.create(TestEntity, { name: 'test-flush-mssql' });
          em1.persist(entity);

          await em1.transactional(async () => {
            entity.name = 'changed-mssql';
          }, {
            propagation: TransactionPropagation.NESTED,
            flushMode: FlushMode.COMMIT,
          });

          await em1.flush();
        });

        const entities = await orm.em.find(TestEntity, {});
        expect(entities[0].name).toBe('changed-mssql');
      });
    });

    describe('Concurrent Transactions', () => {
      it('should handle multiple REQUIRES_NEW transactions in parallel', async () => {
        const em = orm.em.fork();

        await em.transactional(async em1 => {
          await em1.persistAndFlush(em1.create(TestEntity, { name: 'main-mssql' }));

          const promises = Array.from({ length: 3 }, (_, i) =>
            em1.transactional(async em2 => {
              const entity = em2.create(TestEntity, { name: `parallel-mssql-${i}` });
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
          await em1.persistAndFlush(em1.create(TestEntity, { name: 'outer-before-mssql' }));

          try {
            await em1.transactional(async em2 => {
              await em2.persistAndFlush(em2.create(TestEntity, { name: 'inner-fail-mssql' }));
              throw new Error('Inner transaction failed');
            }, { propagation: TransactionPropagation.REQUIRES_NEW });
          } catch (e) {
            // Inner transaction rolled back independently
          }

          await em1.persistAndFlush(em1.create(TestEntity, { name: 'outer-after-mssql' }));
        });

        const entities = await orm.em.find(TestEntity, {});
        expect(entities.map(e => e.name).sort()).toEqual(['outer-after-mssql', 'outer-before-mssql']);
      });
    });

    describe('Clear Option with Propagation', () => {
      it('should clear identity map when specified', async () => {
        const em = orm.em.fork();
        const entity = em.create(TestEntity, { name: 'test-clear-mssql' });
        await em.persistAndFlush(entity);

        await em.transactional(async em1 => {
          const loaded = await em1.findOne(TestEntity, { name: 'test-clear-mssql' });
          expect(loaded).toBeDefined();
          expect(loaded).not.toBe(entity);
        }, {
          clear: true,
        });
      });
    });
  });
});
