import { Entity, MikroORM, PrimaryKey, Property, TransactionPropagation, IsolationLevel, FlushMode } from '@mikro-orm/mariadb';

@Entity()
class TestEntity {

  @PrimaryKey()
  id!: number;

  @Property({ unique: true })
  name!: string;

  @Property({ nullable: true })
  value?: number;

}

describe('Transaction Propagation - MariaDB', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      entities: [TestEntity],
      dbName: 'mikro_orm_test_propagation',
      port: 3309,
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
        const entity1 = em1.create(TestEntity, { name: 'level1-mariadb' });
        await em1.persistAndFlush(entity1);

        await em1.transactional(async em2 => {
          const entity2 = em2.create(TestEntity, { name: 'level2-required-mariadb' });
          await em2.persistAndFlush(entity2);

          await em2.transactional(async em3 => {
            const entity3 = em3.create(TestEntity, { name: 'level3-nested-mariadb' });
            await em3.persistAndFlush(entity3);
          }, { propagation: TransactionPropagation.NESTED });

          await em2.transactional(async em3 => {
            const entity4 = em3.create(TestEntity, { name: 'level3-new-mariadb' });
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
          const entity1 = em1.create(TestEntity, { name: 'outer-mixed-mariadb' });
          await em1.persistAndFlush(entity1);

          // REQUIRES_NEW - should commit independently
          await em1.transactional(async em2 => {
            const entity2 = em2.create(TestEntity, { name: 'independent-mariadb' });
            await em2.persistAndFlush(entity2);
          }, { propagation: TransactionPropagation.REQUIRES_NEW });

          // NESTED - will create savepoint but still fail with outer
          await em1.transactional(async em2 => {
            const entity3 = em2.create(TestEntity, { name: 'nested-mariadb' });
            await em2.persistAndFlush(entity3);
          }, { propagation: TransactionPropagation.NESTED });

          // REQUIRED - should rollback with outer
          await em1.transactional(async em2 => {
            const entity4 = em2.create(TestEntity, { name: 'joined-mariadb' });
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
      expect(entities[0].name).toBe('independent-mariadb');
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle deep nesting with all propagation types', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = em1.create(TestEntity, { name: 'level1-required-mariadb' });
        await em1.persistAndFlush(entity1);

        await em1.transactional(async em2 => {
          const entity2 = em2.create(TestEntity, { name: 'level2-nested-mariadb' });
          await em2.persistAndFlush(entity2);

          await em2.transactional(async em3 => {
            const entity3 = em3.create(TestEntity, { name: 'level3-new-mariadb' });
            await em3.persistAndFlush(entity3);

            await em3.transactional(async em4 => {
              const entity4 = em4.create(TestEntity, { name: 'level4-required-mariadb' });
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
          const entity = em1.create(TestEntity, { name: 'isolated-mariadb' });
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
            const entity = em2.create(TestEntity, { name: 'inner-isolated-mariadb' });
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
          const entity = em1.create(TestEntity, { name: 'test-flush-mariadb' });
          em1.persist(entity);

          await em1.transactional(async () => {
            entity.name = 'changed-mariadb';
          }, {
            propagation: TransactionPropagation.NESTED,
            flushMode: FlushMode.COMMIT,
          });

          await em1.flush();
        });

        const entities = await orm.em.find(TestEntity, {});
        expect(entities[0].name).toBe('changed-mariadb');
      });
    });

    describe('Concurrent Transactions', () => {
      it('should handle multiple REQUIRES_NEW transactions in parallel', async () => {
        const em = orm.em.fork();

        await em.transactional(async em1 => {
          await em1.persistAndFlush(em1.create(TestEntity, { name: 'main-mariadb' }));

          const promises = Array.from({ length: 3 }, (_, i) =>
            em1.transactional(async em2 => {
              const entity = em2.create(TestEntity, { name: `parallel-mariadb-${i}` });
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
          await em1.persistAndFlush(em1.create(TestEntity, { name: 'outer-before-mariadb' }));

          try {
            await em1.transactional(async em2 => {
              await em2.persistAndFlush(em2.create(TestEntity, { name: 'inner-fail-mariadb' }));
              throw new Error('Inner transaction failed');
            }, { propagation: TransactionPropagation.REQUIRES_NEW });
          } catch (e) {
            // Inner transaction rolled back independently
          }

          await em1.persistAndFlush(em1.create(TestEntity, { name: 'outer-after-mariadb' }));
        });

        const entities = await orm.em.find(TestEntity, {});
        expect(entities.map(e => e.name).sort()).toEqual(['outer-after-mariadb', 'outer-before-mariadb']);
      });
    });
  });
});
