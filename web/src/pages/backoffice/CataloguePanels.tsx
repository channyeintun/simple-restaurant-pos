import type { Category, Product, Table } from '@pos/shared';
import { useQueryClient } from '@tanstack/solid-query';
import { For, Show, createMemo, createSignal } from 'solid-js';
import {
  createCategory,
  createProduct,
  createTable,
  updateCategory,
  updateProduct,
  updateTable,
} from '../../api/catalogue.js';
import { Button, Chip, ChipSet, ConfirmButton, TextField } from '../../components/ui.js';
import { catalogueRoot, useCategories, useProducts, useTables } from '../../lib/queries.js';
import { useApp } from '../../state/app.js';
import { useLocale } from '../../state/locale.js';
import { Badge, Empty, FormDialog, ListRow, Panel, QueryView, SectionHead, createAction } from './parts.js';

/**
 * The three lists that decide what a waiter's screen shows: the floor, the
 * chips, and the menu.
 *
 * All three are read with `includeRetired = true`, because this is the one
 * screen in the app that has to see a retired row — bringing one back is the
 * only thing that can be done with it, and a row you cannot see is a row you
 * cannot bring back. The waiter's tablet reads the same routes without the
 * flag and gets only what is on tonight.
 *
 * ## Why every panel invalidates a prefix rather than a key
 *
 * The short list and the long list are two cache entries by design — see
 * `queryKeys` — so an edit made here has to reach both, and only one of them is
 * on this screen. `catalogueRoot.products` matches `['products', true]` and
 * `['products', false]`, so the waiter tab open on the same tablet picks the
 * change up the next time it looks, instead of holding a menu that no longer
 * exists until somebody reloads.
 */

/* ------------------------------------------------------------------ tables */

export function TablesPanel() {
  const { m } = useLocale();
  const queryClient = useQueryClient();
  const tables = useTables(true);
  const action = createAction();

  const [editing, setEditing] = createSignal<Table | null>(null);
  const [adding, setAdding] = createSignal(false);
  const [name, setName] = createSignal('');
  const [sort, setSort] = createSignal('');

  const refresh = () => void queryClient.invalidateQueries({ queryKey: catalogueRoot.tables });

  const openAdd = () => {
    setName('');
    setSort('');
    action.setError(null);
    setAdding(true);
  };

  const openEdit = (table: Table) => {
    setName(table.name);
    setSort(String(table.sort));
    action.setError(null);
    setEditing(table);
  };

  const close = () => {
    setAdding(false);
    setEditing(null);
  };

  const submit = () =>
    void action
      .run(async () => {
        // An empty order field means "leave it where it is" on an edit and
        // "put it at the end" on a create, which is what omitting the key does
        // on both routes. Sending 0 instead would silently move every new table
        // to the front of the grid.
        const order = sort().trim() === '' ? undefined : Number(sort().trim());
        const current = editing();
        if (current) await updateTable(current.id, { name: name(), sort: order });
        else await createTable({ name: name(), sort: order });
      })
      .then((ok) => {
        if (!ok) return;
        refresh();
        close();
      });

  const setActive = (table: Table, active: boolean) =>
    action.run(() => updateTable(table.id, { active })).then((ok) => ok && refresh());

  return (
    <Panel>
      <SectionHead
        title={m().backoffice.sections.tables}
        actions={<Button onClick={openAdd}>{m().backoffice.add}</Button>}
      />

      <QueryView pending={tables.isPending} error={tables.error} data={tables.data}>
        {(rows) => (
          <Show when={rows.length > 0} fallback={<Empty />}>
            <div class="list">
              <For each={rows}>
                {(table) => (
                  <ListRow
                    title={table.name}
                    retired={!table.active}
                    meta={
                      <>
                        <span>
                          {m().backoffice.fields.order} {table.sort}
                        </span>
                        <Show when={!table.active}>
                          <Badge>{m().backoffice.retired}</Badge>
                        </Show>
                      </>
                    }
                    actions={
                      <RowActions
                        active={table.active}
                        name={table.name}
                        busy={action.busy()}
                        onEdit={() => openEdit(table)}
                        onRetire={() => void setActive(table, false)}
                        onRestore={() => void setActive(table, true)}
                      />
                    }
                  />
                )}
              </For>
            </div>
          </Show>
        )}
      </QueryView>

      <FormDialog
        open={adding() || editing() !== null}
        onClose={close}
        headline={editing() ? m().backoffice.edit : m().backoffice.sections.tables}
        submitLabel={m().backoffice.save}
        busy={action.busy()}
        error={action.error()}
        onSubmit={submit}
      >
        <TextField
          label={m().backoffice.fields.name}
          value={name()}
          onChange={setName}
          required
          maxLength={20}
        />
        <OrderField value={sort()} onChange={setSort} />
      </FormDialog>
    </Panel>
  );
}

/* -------------------------------------------------------------- categories */

export function CategoriesPanel() {
  const { m } = useLocale();
  const queryClient = useQueryClient();
  const categories = useCategories(true);
  const action = createAction();

  const [editing, setEditing] = createSignal<Category | null>(null);
  const [adding, setAdding] = createSignal(false);
  const [name, setName] = createSignal('');
  const [sort, setSort] = createSignal('');

  /*
   * Retiring a category invalidates the products too. A product whose category
   * is off the chips is a product with nowhere to be tapped, so the waiter's
   * menu has genuinely changed even though no product row did — and a cached
   * product list that has not noticed is a tile leading nowhere.
   */
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: catalogueRoot.categories });
    void queryClient.invalidateQueries({ queryKey: catalogueRoot.products });
  };

  const openAdd = () => {
    setName('');
    setSort('');
    action.setError(null);
    setAdding(true);
  };

  const openEdit = (category: Category) => {
    setName(category.name);
    setSort(String(category.sort));
    action.setError(null);
    setEditing(category);
  };

  const close = () => {
    setAdding(false);
    setEditing(null);
  };

  const submit = () =>
    void action
      .run(async () => {
        const order = sort().trim() === '' ? undefined : Number(sort().trim());
        const current = editing();
        if (current) await updateCategory(current.id, { name: name(), sort: order });
        else await createCategory({ name: name(), sort: order });
      })
      .then((ok) => {
        if (!ok) return;
        refresh();
        close();
      });

  const setActive = (category: Category, active: boolean) =>
    action.run(() => updateCategory(category.id, { active })).then((ok) => ok && refresh());

  return (
    <Panel>
      <SectionHead
        title={m().backoffice.sections.categories}
        actions={<Button onClick={openAdd}>{m().backoffice.add}</Button>}
      />

      <QueryView pending={categories.isPending} error={categories.error} data={categories.data}>
        {(rows) => (
          <Show when={rows.length > 0} fallback={<Empty />}>
            <div class="list">
              <For each={rows}>
                {(category) => (
                  <ListRow
                    title={category.name}
                    retired={!category.active}
                    meta={
                      <>
                        <span>
                          {m().backoffice.fields.order} {category.sort}
                        </span>
                        <Show when={!category.active}>
                          <Badge>{m().backoffice.retired}</Badge>
                        </Show>
                      </>
                    }
                    actions={
                      <RowActions
                        active={category.active}
                        name={category.name}
                        busy={action.busy()}
                        onEdit={() => openEdit(category)}
                        onRetire={() => void setActive(category, false)}
                        onRestore={() => void setActive(category, true)}
                      />
                    }
                  />
                )}
              </For>
            </div>
          </Show>
        )}
      </QueryView>

      <FormDialog
        open={adding() || editing() !== null}
        onClose={close}
        headline={editing() ? m().backoffice.edit : m().backoffice.sections.categories}
        submitLabel={m().backoffice.save}
        busy={action.busy()}
        error={action.error()}
        onSubmit={submit}
      >
        <TextField
          label={m().backoffice.fields.name}
          value={name()}
          onChange={setName}
          required
          maxLength={40}
        />
        <OrderField value={sort()} onChange={setSort} />
      </FormDialog>
    </Panel>
  );
}

/* ---------------------------------------------------------------- products */

export function ProductsPanel() {
  const { m } = useLocale();
  const app = useApp();
  const queryClient = useQueryClient();
  const categories = useCategories(true);
  const products = useProducts(true);
  const action = createAction();

  const [editing, setEditing] = createSignal<Product | null>(null);
  const [adding, setAdding] = createSignal(false);
  const [name, setName] = createSignal('');
  const [price, setPrice] = createSignal('');
  const [sort, setSort] = createSignal('');
  const [categoryId, setCategoryId] = createSignal<string | null>(null);
  /** Null is "all", and it is the chip the screen opens on. */
  const [filter, setFilter] = createSignal<string | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: catalogueRoot.products });

  /** Category names by id, so a row can say which one it is in without a scan. */
  const categoryName = createMemo(() => {
    const names = new Map<string, string>();
    for (const category of categories.data ?? []) names.set(category.id, category.name);
    return names;
  });

  const visible = createMemo(() => {
    const chosen = filter();
    const rows = products.data ?? [];
    return chosen === null ? rows : rows.filter((product) => product.categoryId === chosen);
  });

  const openAdd = () => {
    setName('');
    setPrice('');
    setSort('');
    // Whatever is being filtered by is the likeliest category for the next
    // product, and the first category otherwise — a manager adding three
    // curries in a row should not pick "Curries" three times.
    setCategoryId(filter() ?? categories.data?.find((category) => category.active)?.id ?? null);
    action.setError(null);
    setAdding(true);
  };

  const openEdit = (product: Product) => {
    setName(product.name);
    setPrice(app.amount(product.priceMinor));
    setSort(String(product.sort));
    setCategoryId(product.categoryId);
    action.setError(null);
    setEditing(product);
  };

  const close = () => {
    setAdding(false);
    setEditing(null);
  };

  const submit = () =>
    void action
      .run(async () => {
        const chosen = categoryId();
        if (!chosen) throw new Error(m().backoffice.categoryRequired);

        // Parsed here rather than trusted as a number, and refused rather than
        // rounded: `parseAmount` answers null for anything it cannot read, and
        // a price that silently became zero is a product given away for the
        // rest of the month.
        const priceMinor = app.parseAmount(price());
        if (priceMinor === null) throw new Error(m().backoffice.priceInvalid);

        const order = sort().trim() === '' ? undefined : Number(sort().trim());
        const current = editing();
        if (current) {
          await updateProduct(current.id, {
            categoryId: chosen,
            name: name(),
            priceMinor,
            sort: order,
          });
        } else {
          await createProduct({ categoryId: chosen, name: name(), priceMinor, sort: order });
        }
      })
      .then((ok) => {
        if (!ok) return;
        refresh();
        close();
      });

  const setActive = (product: Product, active: boolean) =>
    action.run(() => updateProduct(product.id, { active })).then((ok) => ok && refresh());

  return (
    <Panel>
      <SectionHead
        title={m().backoffice.sections.products}
        actions={
          <Button onClick={openAdd} disabled={(categories.data?.length ?? 0) === 0}>
            {m().backoffice.add}
          </Button>
        }
      />

      {/*
        The category filter. It is an ordinary filter chip set rather than a
        select, because the whole list is already on the tablet — filtering is
        instant and costs nothing — and because a chip is a 48px target and a
        native select on a touch screen is a system sheet.
      */}
      <Show when={(categories.data?.length ?? 0) > 0}>
        <ChipSet ariaLabel={m().backoffice.fields.category}>
          <Chip
            label={m().backoffice.all}
            selected={filter() === null}
            onClick={() => setFilter(null)}
          />
          <For each={categories.data}>
            {(category) => (
              <Chip
                label={category.name}
                selected={filter() === category.id}
                onClick={() => setFilter(category.id)}
              />
            )}
          </For>
        </ChipSet>
      </Show>

      <QueryView pending={products.isPending} error={products.error} data={visible()}>
        {(rows) => (
          <Show when={rows.length > 0} fallback={<Empty />}>
            <div class="list">
              <For each={rows}>
                {(product) => (
                  <ListRow
                    title={product.name}
                    retired={!product.active}
                    meta={
                      <>
                        <span class="money">{app.money(product.priceMinor)}</span>
                        <span>{categoryName().get(product.categoryId) ?? '—'}</span>
                        <Show when={!product.active}>
                          <Badge>{m().backoffice.retired}</Badge>
                        </Show>
                      </>
                    }
                    actions={
                      <RowActions
                        active={product.active}
                        name={product.name}
                        busy={action.busy()}
                        onEdit={() => openEdit(product)}
                        onRetire={() => void setActive(product, false)}
                        onRestore={() => void setActive(product, true)}
                      />
                    }
                  />
                )}
              </For>
            </div>
          </Show>
        )}
      </QueryView>

      <FormDialog
        open={adding() || editing() !== null}
        onClose={close}
        headline={editing() ? m().backoffice.edit : m().backoffice.sections.products}
        submitLabel={m().backoffice.save}
        busy={action.busy()}
        error={action.error()}
        onSubmit={submit}
      >
        <TextField
          label={m().backoffice.fields.name}
          value={name()}
          onChange={setName}
          required
          maxLength={60}
        />

        {/*
          `type="text"` with a numeric keyboard, never `type="number"`. A number
          input hands back a float, disagrees with itself about the decimal mark
          across locales, and has spinner arrows nobody wants on a price. The
          text goes through `parseAmount`, which is the same function the rest
          of the app reads an amount with.
        */}
        <TextField
          label={m().backoffice.fields.price}
          value={price()}
          onChange={setPrice}
          inputMode="numeric"
          supportingText={m().backoffice.priceHint(app.config().currency.symbol)}
          required
        />

        <p class="form-label">{m().backoffice.fields.category}</p>
        <ChipSet ariaLabel={m().backoffice.fields.category}>
          <For each={categories.data}>
            {(category) => (
              <Chip
                label={category.name}
                selected={categoryId() === category.id}
                onClick={() => setCategoryId(category.id)}
              />
            )}
          </For>
        </ChipSet>

        <OrderField value={sort()} onChange={setSort} />
      </FormDialog>
    </Panel>
  );
}

/* ------------------------------------------------------------------ shared */

/**
 * The order field, which is the same on all three forms.
 *
 * A number somebody types, and deliberately not drag-to-reorder: the brief
 * rules out drag-and-drop outright, and a touch gesture for reordering a grid
 * is one nobody would guess and nobody could do one-handed. Left blank on a
 * create, the Worker puts the row at the end, which is what somebody adding a
 * sixth table means.
 */
function OrderField(props: { value: string; onChange(value: string): void }) {
  const { m } = useLocale();
  return (
    <TextField
      label={m().backoffice.fields.order}
      value={props.value}
      onChange={props.onChange}
      inputMode="numeric"
      supportingText={m().backoffice.orderHint}
      maxLength={4}
    />
  );
}

/**
 * Edit, and then either Retire or Bring back.
 *
 * Retiring goes through a confirm dialog that names the consequence, because it
 * takes something off every tablet in the building. Bringing one back does not:
 * it adds, it is trivially undone by retiring again, and a confirmation on a
 * harmless action is what teaches people to dismiss confirmations without
 * reading them.
 */
function RowActions(props: {
  active: boolean;
  name: string;
  busy: boolean;
  onEdit(): void;
  onRetire(): void;
  onRestore(): void;
}) {
  const { m } = useLocale();

  return (
    <>
      <Button variant="text" disabled={props.busy} onClick={props.onEdit}>
        {m().backoffice.edit}
      </Button>
      <Show
        when={props.active}
        fallback={
          <Button variant="outlined" disabled={props.busy} onClick={props.onRestore}>
            {m().backoffice.restore}
          </Button>
        }
      >
        <ConfirmButton
          headline={m().backoffice.retireHeadline}
          body={m().backoffice.retireBody(props.name)}
          confirmLabel={m().backoffice.retire}
          disabled={props.busy}
          onConfirm={props.onRetire}
        >
          {m().backoffice.retire}
        </ConfirmButton>
      </Show>
    </>
  );
}
