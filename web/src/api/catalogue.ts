import {
  type Category,
  type CreateCategoryInput,
  type CreateProductInput,
  type CreateTableInput,
  type Product,
  type Table,
  type UpdateCategoryInput,
  type UpdateProductInput,
  type UpdateTableInput,
  categorySchema,
  productSchema,
  tableSchema,
} from '@pos/shared';
import { z } from 'zod';
import { get, patch, post } from './client.js';

/**
 * The menu and the floor.
 *
 * Nine calls with one shape between them, because the three resources have one
 * shape between them: a hand-ordered list of named rows that are retired rather
 * than deleted. There is deliberately **no delete function in this file** — the
 * Worker has no route for one, and a wrapper that sent `DELETE` would be a
 * button somebody could add to a screen before finding out.
 *
 * `auth.ts` carries the argument for parsing every response rather than casting
 * it, and it applies to all nine: the two sides of this wire are written in
 * different languages against a contract that lives in a third place, and a
 * field that drifted would surface as a blank line on a bill three components
 * away rather than as an error at the boundary.
 *
 * ## `includeRetired`
 *
 * The same route answers the floor and the backoffice, and `?include=all` is
 * what asks for the second. It is not a client-side convenience: the Worker
 * requires the admin role to answer it, because a waiter's grid must show only
 * what is on tonight — a retired table is a tile somebody taps by mistake
 * during service — while the manager editing the floor has to see the retired
 * ones, since bringing one back is the only thing that can be done with it.
 */
const listSuffix = (includeRetired: boolean) => (includeRetired ? '?include=all' : '');

/* ------------------------------------------------------------------ tables */

const tableListSchema = z.array(tableSchema);

export const listTables = (includeRetired = false, signal?: AbortSignal): Promise<Table[]> =>
  get<unknown>(`/tables${listSuffix(includeRetired)}`, signal).then((body) =>
    tableListSchema.parse(body),
  );

export const createTable = (input: CreateTableInput): Promise<Table> =>
  post<unknown>('/tables', input).then((body) => tableSchema.parse(body));

export const updateTable = (id: string, input: UpdateTableInput): Promise<Table> =>
  patch<unknown>(`/tables/${id}`, input).then((body) => tableSchema.parse(body));

/* -------------------------------------------------------------- categories */

const categoryListSchema = z.array(categorySchema);

export const listCategories = (
  includeRetired = false,
  signal?: AbortSignal,
): Promise<Category[]> =>
  get<unknown>(`/categories${listSuffix(includeRetired)}`, signal).then((body) =>
    categoryListSchema.parse(body),
  );

export const createCategory = (input: CreateCategoryInput): Promise<Category> =>
  post<unknown>('/categories', input).then((body) => categorySchema.parse(body));

export const updateCategory = (id: string, input: UpdateCategoryInput): Promise<Category> =>
  patch<unknown>(`/categories/${id}`, input).then((body) => categorySchema.parse(body));

/* ---------------------------------------------------------------- products */

const productListSchema = z.array(productSchema);

/**
 * The whole menu in one response, rather than a request per category.
 *
 * That is a decision about the waiter's screen: the category chips filter a
 * list the tablet is already holding, so switching from Curries to Drinks is
 * instant and costs nothing. A restaurant's menu is a hundred rows at the
 * outside — a few kilobytes fetched once when the screen opens, against a round
 * trip per chip tap for the rest of the shift.
 */
export const listProducts = (includeRetired = false, signal?: AbortSignal): Promise<Product[]> =>
  get<unknown>(`/products${listSuffix(includeRetired)}`, signal).then((body) =>
    productListSchema.parse(body),
  );

export const createProduct = (input: CreateProductInput): Promise<Product> =>
  post<unknown>('/products', input).then((body) => productSchema.parse(body));

export const updateProduct = (id: string, input: UpdateProductInput): Promise<Product> =>
  patch<unknown>(`/products/${id}`, input).then((body) => productSchema.parse(body));
