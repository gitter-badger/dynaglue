import { getChildCollection, assemblePrimaryKeyValue, unwrap } from '../base/util';
import { QueryInput, Key, Converter } from 'aws-sdk/clients/dynamodb';
import { Context } from '../context';
import { DocumentWithId, WrappedDocument } from '../base/common';
import debugDynamo from '../debug/debugDynamo';
import { CompositeCondition } from '../base/conditions';
import { createNameMapper, createValueMapper } from '../base/mappers';

/**
  * The results of a [[findChildren]] operation.
  */
export type FindChildrenResults = {
  /** the items that were returned in this batch */
  items: DocumentWithId[];
  /** The pagination token. If this value is specified, it means
    * there is more results for the query. Provide it to another
    * call to `findChildren` to get the next set of results.
    */
  nextToken?: Key;
};

/**
 * Find all the child objects of a root (top-level) object.
 *
 * The parent collection is determined by the reference in the
 * child collection.
 *
 * This method has a `nextToken`, which is used for pagination - it
 * is returned when there is more values to retrieve. You should
 * write your code to repeatedly call findChildren with the nextToken
 * value of the previous call until it comes back undefined in order
 * to retrieve all the values.
 *
 * @param ctx the context
 * @param childCollectionName name of the child object collection
 * @param rootObjectId the `_id` of the root object
 * @param nextToken the next token from the previous call, or `undefined` if there are no more values
 * @param options the options to control the query
 * @param options.limit number of records to return
 * @param options.scanForward=true true for ascending index order
 * @param options.filter an optional filter expression to apply
 * @throws {CollectionNotFoundException} when the collection is not found in the context
 */
export async function findChildren(
  ctx: Context,
  childCollectionName: string,
  rootObjectId: string,
  nextToken?: Key,
  options: { limit?: number; scanForward?: boolean; filter?: CompositeCondition } = {},
): Promise<FindChildrenResults> {
  const childCollection = getChildCollection(ctx, childCollectionName);
  const nameMapper = createNameMapper();
  const valueMapper = createValueMapper();

  const { 
    parentCollectionName, 
    layout: { primaryKey: { partitionKey, sortKey } }, 
  } = childCollection;

  const parentId = assemblePrimaryKeyValue(parentCollectionName, rootObjectId, childCollection.layout.indexKeySeparator);
  const childCollectionPrefix = assemblePrimaryKeyValue(childCollectionName, '', childCollection.layout.indexKeySeparator);

  const keyConditionExpression = `${nameMapper.map(partitionKey)} = ${valueMapper.map(parentId)} ` + 
    `AND begins_with(${nameMapper.map(sortKey)}, ${valueMapper.map(childCollectionPrefix)})`;
  const request: QueryInput = {
    TableName: childCollection.layout.tableName,
    KeyConditionExpression: keyConditionExpression,
    ExpressionAttributeNames: nameMapper.get(),
    ExpressionAttributeValues: valueMapper.get(),
    ExclusiveStartKey: nextToken,
    Limit: options?.limit,
    ScanIndexForward: options?.scanForward ?? true, 
  };

  debugDynamo('Query', request);
  const results = await ctx.ddb.query(request).promise();
  return {
    items: (results.Items||[]).map(item => unwrap(Converter.unmarshall(item) as WrappedDocument)),
    nextToken: results.LastEvaluatedKey,
  };
}
