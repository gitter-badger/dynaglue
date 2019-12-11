import isEqual from 'lodash/isEqual';
import { Key, QueryInput, Converter } from 'aws-sdk/clients/dynamodb';

import { Context } from '../context';
import { DocumentWithId, WrappedDocument } from '../base/common';
import { getCollection, unwrap, assembleIndexedValue, IndexedValue } from '../base/util';
import { Collection } from '../base/collection';
import { InvalidQueryException, ConfigurationException } from '../base/exceptions';
import { KeyPath, AccessPattern, AccessPatternOptions } from '../base/access_pattern';
import { SecondaryIndexLayout } from '../base/layout';

type QueryOperator = 'match' | 'equals';

type FindQuery = { [matchKey: string]: string };

type FindResults = {
  items: DocumentWithId[];
  nextToken?: Key;
};

export const isEqualKey = (lhs: string[] | string, rhs: string[] | string): boolean => {
  const normalisedLhs = typeof lhs === 'string' ? lhs.split('.') : lhs;
  const normalisedRhs = typeof rhs === 'string' ? rhs.split('.') : rhs;
  return isEqual(normalisedLhs, normalisedRhs);
};

export const findAccessPattern = (collection: Collection, query: FindQuery): AccessPattern | undefined => {
  return (collection.accessPatterns || []).find(ap => {
    const unmatchedQueryKeys = [...Object.keys(query)];
    for (const apKey of ap.partitionKeys) {
      const matchingQueryKeyIndex = unmatchedQueryKeys.findIndex(queryKey => isEqualKey(apKey, queryKey));
      if (matchingQueryKeyIndex >= 0) {
        unmatchedQueryKeys.splice(matchingQueryKeyIndex, 1);
      } else {
        return false;
      }
    }

    if (ap.sortKeys) {
      for (const apKey of ap.sortKeys) {
        const matchingQueryKeyIndex = unmatchedQueryKeys.findIndex(queryKey => isEqualKey(apKey, queryKey));
        if (matchingQueryKeyIndex >= 0) {
          unmatchedQueryKeys.splice(matchingQueryKeyIndex, 1);
        } else {
          break;
        }
      }
    }
    return unmatchedQueryKeys.length === 0;
  });
};

export const findAccessPatternLayout = (findKeys: SecondaryIndexLayout[], ap: AccessPattern): SecondaryIndexLayout | undefined =>
  findKeys.find(fk => fk.indexName === ap.indexName);

export const assembleQueryValue = (
  type: 'partition' | 'sort',
  collectionName: string,
  query: FindQuery,
  options: AccessPatternOptions,
  paths?: KeyPath[]
): IndexedValue => {
  if (paths) {
    const values: IndexedValue[] = [];
    for (const path of paths) {
      const pathValue = query[path.join('.')];
      if (!pathValue) break;
      const transformedValue = options.stringNormalizer ? options.stringNormalizer(path, pathValue) : pathValue;
      values.push(transformedValue);
    }
    return assembleIndexedValue(type, collectionName, values);
  }
  return undefined;
};

// FIXME: distinguish `=` and `begins_with` based on specified sort keys
const getQueryOperator = (sortKeyName: string, sortValueName: string, qo?: QueryOperator): string => {
  switch (qo) {
  case 'equals': return `${sortKeyName} = ${sortValueName}`;
  default:
  case 'match':
    return `begins_with(${sortKeyName}, ${sortValueName})`;
  }
  throw new Error('unreachable');
}
  ;

/**
 * Find an item using one of its collection's access patterns
 *
 * This method is very strict about how the query object is used. Failure
 * to specify it
 *
 * Each of its keys is one of the keys paths to a field in the collection objects
 * (separated by a full-stop `.`), with the values set to the value to
 * match against. The value is a direct string comparison, so only string
 * values can be looked up (the query object cannot contain nested values
 * or values of types other than string)
 *
 * Every path that is specified must be part of the same access pattern.
 * You cannot have extraneous fields to match or mix keys from different
 * access patterns.
 *
 * All of the key paths in the partition key part of the access pattern
 * must be specified.
 *
 * You do not have to specify all of the sort keys,
 * **but** because they are stored as a composite key, and we can only do
 * `begins_with` match, you must specify the keys in the order they appear,
 * only leaving off those at the end.
 *
 * For example, if your sort key is defined as:
 *
 * ``[['state'], ['city'], ['street', 'name'], ['street', 'number']]```
 *
 * you could specify any of the following combinations:
 * - `{ state: '...' }`
 * - `{ state: '...', city: '...' }`
 * - `{ state: '...', city: '...', 'street.name': '...' }`
 * - `{ state: '...', city: '...', 'street.name': '...', 'street.number': '...' }`
 *
 * But these would be invalid:
 * - `{ city: '...' }`
 * - `{ state: '...', 'street.name': '...' }`
 * - `{ city: '...', 'street.name': '...', 'street.number': '...' }`
 *
 *
 * @param ctx the context object
 * @param collectionName the collection name
 * @param query an object, with each of its keys set to the path of
 * each field in the search object to match and their corresponding
 * values to match (see above)s
 * @param nextToken pagination token
 * @param options options controlling the query
 * @returns an object containing the items found and a pagination token
 * (if there is more results)
 */
export async function find(
  ctx: Context,
  collectionName: string,
  query: FindQuery,
  nextToken?: Key,
  options?: {
    queryOperator: QueryOperator;
  }
): Promise<FindResults> {
  const collection = getCollection(ctx, collectionName);

  const ap = findAccessPattern(collection, query);
  if (!ap) {
    throw new InvalidQueryException('Unable to find access pattern matching query', {
      collection: collectionName,
      query,
    });
  }
  const layout = findAccessPatternLayout(collection.layout?.findKeys ?? [], ap);
  if (!layout) {
    throw new ConfigurationException(
      `Unable to find layout for index specified in access pattern`,
      { info: { collectionName, indexName: ap.indexName } },
    );
  }

  const partitionKeyValue = assembleQueryValue('partition', collection.name, query, ap.options || {}, ap.partitionKeys);
  const sortKeyValue = assembleQueryValue('sort', collection.name, query, ap.options || {}, ap.sortKeys);

  const sortKeyOp = sortKeyValue && getQueryOperator('#indexSortKey', ':indexSortKey', options?.queryOperator);
  const queryRequest: QueryInput = {
    TableName: collection.layout.tableName,
    IndexName: ap.indexName,
    KeyConditionExpression: `#indexPartitionKey = :indexPartitionKey${sortKeyValue ? ` AND ${sortKeyOp}` : ''}`,
    ExpressionAttributeNames: {
      '#indexPartitionKey': layout.partitionKey,
      ...(sortKeyValue && layout.sortKey ? { '#indexSortKey': layout.sortKey } : {}),
    },
    ExpressionAttributeValues: {
      ':indexPartitionKey': { S: partitionKeyValue },
      ...(sortKeyValue && layout.sortKey ? { ':indexSortKey': { S: sortKeyValue } } : {}),
    },
    ExclusiveStartKey: nextToken,
  };
  const { Items: items, LastEvaluatedKey: lastEvaluatedKey } = await ctx.ddb.query(queryRequest).promise();
  const unwrappedItems = items ? items.map(item => unwrap(Converter.unmarshall(item) as WrappedDocument)) : [];
  return {
    items: unwrappedItems,
    nextToken: lastEvaluatedKey,
  };
}