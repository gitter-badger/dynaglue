/**
 * The structure of your primary index. Your table
 * must have a partition and sort keys, both of
 * type 'S' (string)
 */
export type PrimaryIndexLayout = {
  /**
   * The name of the primary partition key
   */
  partitionKey: string;
  /**
   * The name of the primary sort key
   */
  sortKey: string;
}

/**
 * The structure of a Global Secondary Index
 */
export type SecondaryIndexLayout = {
  /**
   * The name of the secondary index
   */
  indexName: string;
  /**
   * The name of the secondary index partition key
   */
  partitionKey: string;
  /**
   * The name of the secondary index sort key. If
   * your index does not have one, leave this as
   * `undefined`
   */
  sortKey?: string;
}

/**
 * The layout of a collection. Defines the structure
 * of the underlying tabel, its primary keys and sort
 * keys.
 */
export interface CollectionLayout {
  /** Name of the table */
  tableName: string;
  /** Layout of the primary key */
  primaryKey: PrimaryIndexLayout;
  /** Layout of the list-all key. This is an optional secondary index
   * that, if defined, must be the inverse of the primary key.
   */
  listAllKey?: SecondaryIndexLayout;
  /**
   * Optional secondary find keys for additional lookups
   */
  findKeys?: SecondaryIndexLayout[];
};