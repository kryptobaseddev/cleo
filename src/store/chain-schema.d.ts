/**
 * Drizzle ORM schema for WarpChain storage in tasks.db.
 *
 * Tables: warp_chains, warp_chain_instances
 * Stores chain definitions and runtime instances bound to epics.
 *
 * @task T5403
 */
/** Chain instance status values. */
export declare const WARP_CHAIN_INSTANCE_STATUSES: readonly ["pending", "active", "completed", "failed", "cancelled"];
/** Stored WarpChain definitions (serialized as JSON). */
export declare const warpChains: import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
    name: "warp_chains";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: string;
            tableName: "warp_chains";
            dataType: "string";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
        name: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: string;
            tableName: "warp_chains";
            dataType: "string";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
        version: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: string;
            tableName: "warp_chains";
            dataType: "string";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
        description: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: string;
            tableName: "warp_chains";
            dataType: "string";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
        definition: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: string;
            tableName: "warp_chains";
            dataType: "string";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
        validated: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: string;
            tableName: "warp_chains";
            dataType: "boolean";
            data: boolean;
            driverParam: number;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
        createdAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: string;
            tableName: "warp_chains";
            dataType: "string";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
        updatedAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: string;
            tableName: "warp_chains";
            dataType: "string";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
    };
    dialect: "sqlite";
}>;
/** Runtime chain instances bound to epics. */
export declare const warpChainInstances: import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
    name: "warp_chain_instances";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: string;
            tableName: "warp_chain_instances";
            dataType: "string";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
        chainId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: string;
            tableName: "warp_chain_instances";
            dataType: "string";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
        epicId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: string;
            tableName: "warp_chain_instances";
            dataType: "string";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
        variables: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: string;
            tableName: "warp_chain_instances";
            dataType: "string";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
        stageToTask: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: string;
            tableName: "warp_chain_instances";
            dataType: "string";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
        status: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: string;
            tableName: "warp_chain_instances";
            dataType: "string";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
        currentStage: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: string;
            tableName: "warp_chain_instances";
            dataType: "string";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
        gateResults: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: string;
            tableName: "warp_chain_instances";
            dataType: "string";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
        createdAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: string;
            tableName: "warp_chain_instances";
            dataType: "string";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
        updatedAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: string;
            tableName: "warp_chain_instances";
            dataType: "string";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
    };
    dialect: "sqlite";
}>;
export type WarpChainRow = typeof warpChains.$inferSelect;
export type NewWarpChainRow = typeof warpChains.$inferInsert;
export type WarpChainInstanceRow = typeof warpChainInstances.$inferSelect;
export type NewWarpChainInstanceRow = typeof warpChainInstances.$inferInsert;
//# sourceMappingURL=chain-schema.d.ts.map