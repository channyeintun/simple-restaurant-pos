import type { ClaimLink, Device, StaffRole, StaffRosterEntry } from '@pos/shared';
import { useQueryClient } from '@tanstack/solid-query';
import { For, Show, createSignal } from 'solid-js';
import {
  createDevice,
  createStaff,
  mintClaimLink,
  revokeDevice,
  setStaffPin,
  updateStaff,
} from '../../api/admin.js';
import { Button, Chip, ChipSet, ConfirmButton, Dialog, TextField } from '../../components/ui.js';
import { queryKeys, useDevices, useRoster } from '../../lib/queries.js';
import { platform } from '../../platform/index.js';
import { useApp } from '../../state/app.js';
import { useLocale } from '../../state/locale.js';
import { Badge, Empty, FormDialog, ListRow, Panel, QueryView, SectionHead, createAction } from './parts.js';

/**
 * The two lists that decide who can use this restaurant's tills, and from what.
 *
 * They are in one file because they are one job: a person is hired, given four
 * digits, and handed a tablet, and the reason a shift cannot start is usually
 * one of those three rather than the menu.
 */

const ROLES: StaffRole[] = ['waiter', 'cashier', 'admin'];

/* ------------------------------------------------------------------- staff */

export function StaffPanel() {
  const { m } = useLocale();
  const queryClient = useQueryClient();
  const roster = useRoster();
  const action = createAction();
  const pinAction = createAction();

  const [editing, setEditing] = createSignal<StaffRosterEntry | null>(null);
  const [adding, setAdding] = createSignal(false);
  const [name, setName] = createSignal('');
  const [role, setRole] = createSignal<StaffRole>('waiter');

  const [pinFor, setPinFor] = createSignal<StaffRosterEntry | null>(null);
  const [pin, setPin] = createSignal('');

  /*
   * Two keys, because there are two lists of staff and they are read by
   * different people. `roster` is this screen — everybody, including the people
   * who have left. `staff` is the PIN screen's three columns, which every
   * tablet in the building is holding, and hiring somebody who cannot be seen
   * there until the cache expires is somebody who cannot start their shift.
   */
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.roster });
    void queryClient.invalidateQueries({ queryKey: queryKeys.staff });
  };

  const openAdd = () => {
    setName('');
    setRole('waiter');
    action.setError(null);
    setAdding(true);
  };

  const openEdit = (person: StaffRosterEntry) => {
    setName(person.name);
    setRole(person.role);
    action.setError(null);
    setEditing(person);
  };

  const close = () => {
    setAdding(false);
    setEditing(null);
  };

  const submit = () =>
    void action
      .run(async () => {
        const current = editing();
        if (current) await updateStaff(current.id, { name: name(), role: role() });
        else await createStaff({ name: name(), role: role() });
      })
      .then((ok) => {
        if (!ok) return;
        refresh();
        close();
      });

  const setActive = (person: StaffRosterEntry, active: boolean) =>
    action.run(() => updateStaff(person.id, { active })).then((ok) => ok && refresh());

  const openPin = (person: StaffRosterEntry) => {
    setPin('');
    pinAction.setError(null);
    setPinFor(person);
  };

  const submitPin = () =>
    void pinAction
      .run(async () => {
        const person = pinFor();
        if (person) await setStaffPin(person.id, pin());
      })
      .then((ok) => {
        if (!ok) return;
        refresh();
        setPinFor(null);
      });

  return (
    <Panel>
      <SectionHead
        title={m().backoffice.sections.staff}
        actions={<Button onClick={openAdd}>{m().backoffice.add}</Button>}
      />

      <QueryView pending={roster.isPending} error={roster.error} data={roster.data}>
        {(rows) => (
          <Show when={rows.length > 0} fallback={<Empty />}>
            <div class="list">
              <For each={rows}>
                {(person) => (
                  <ListRow
                    title={person.name}
                    retired={!person.active}
                    meta={
                      <>
                        <span>{m().roles[person.role]}</span>
                        {/*
                          Somebody with no PIN is on the roster and cannot sign
                          in anywhere, which is a state worth shouting about in
                          amber: it is the commonest reason a new starter stands
                          at a tablet unable to begin.
                        */}
                        <Show
                          when={person.hasPin}
                          fallback={<Badge tone="warn">{m().staffAdmin.noPin}</Badge>}
                        >
                          <Badge tone="ok">{m().staffAdmin.pinSet}</Badge>
                        </Show>
                        <Show when={!person.active}>
                          <Badge>{m().backoffice.retired}</Badge>
                        </Show>
                      </>
                    }
                    actions={
                      <>
                        <Button
                          variant="text"
                          disabled={action.busy()}
                          onClick={() => openEdit(person)}
                        >
                          {m().backoffice.edit}
                        </Button>
                        <Button
                          variant="text"
                          disabled={action.busy() || !person.active}
                          onClick={() => openPin(person)}
                        >
                          {person.hasPin ? m().staffAdmin.changePin : m().staffAdmin.setPin}
                        </Button>
                        <Show
                          when={person.active}
                          fallback={
                            <Button
                              variant="outlined"
                              disabled={action.busy()}
                              onClick={() => void setActive(person, true)}
                            >
                              {m().backoffice.restore}
                            </Button>
                          }
                        >
                          <ConfirmButton
                            headline={m().backoffice.retireHeadline}
                            body={m().backoffice.retireBody(person.name)}
                            confirmLabel={m().backoffice.retire}
                            disabled={action.busy()}
                            onConfirm={() => void setActive(person, false)}
                          >
                            {m().backoffice.retire}
                          </ConfirmButton>
                        </Show>
                      </>
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
        headline={editing() ? m().backoffice.edit : m().backoffice.sections.staff}
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
        <p class="form-label">{m().backoffice.fields.role}</p>
        <ChipSet ariaLabel={m().backoffice.fields.role}>
          <For each={ROLES}>
            {(option) => (
              <Chip
                label={m().roles[option]}
                selected={role() === option}
                onClick={() => setRole(option)}
              />
            )}
          </For>
        </ChipSet>
      </FormDialog>

      {/*
        The PIN dialog is its own, with its own action, rather than another mode
        of the editor above. It is a different route, a different failure — those
        four digits are already somebody else's — and it must not be possible to
        change a name and a PIN in one press, because the two have very
        different consequences if the request half-lands.
      */}
      <FormDialog
        open={pinFor() !== null}
        onClose={() => setPinFor(null)}
        headline={m().staffAdmin.pinHeadline(pinFor()?.name ?? '')}
        submitLabel={m().backoffice.save}
        busy={pinAction.busy()}
        error={pinAction.error()}
        onSubmit={submitPin}
      >
        <TextField
          label={m().staffAdmin.setPin}
          value={pin()}
          onChange={(value) => setPin(value.replace(/\D/g, '').slice(0, 4))}
          inputMode="numeric"
          maxLength={4}
          supportingText={m().staffAdmin.pinHint}
          required
        />
      </FormDialog>
    </Panel>
  );
}

/* ----------------------------------------------------------------- devices */

export function DevicesPanel() {
  const { m } = useLocale();
  const app = useApp();
  const queryClient = useQueryClient();
  const devices = useDevices();
  const action = createAction();

  const [adding, setAdding] = createSignal(false);
  const [name, setName] = createSignal('');
  /** The one link that exists, for as long as this dialog is open. */
  const [link, setLink] = createSignal<ClaimLink | null>(null);
  const [copied, setCopied] = createSignal(false);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.devices });

  const openAdd = () => {
    setName('');
    action.setError(null);
    setAdding(true);
  };

  const submit = () =>
    void action.run(() => createDevice({ name: name() })).then((ok) => {
      if (!ok) return;
      refresh();
      setAdding(false);
    });

  const mint = (device: Device) =>
    void action.run(async () => setLink(await mintClaimLink(device.id))).then((ok) => {
      if (!ok) return;
      setCopied(false);
      refresh();
    });

  const revoke = (device: Device) =>
    action.run(() => revokeDevice(device.id)).then((ok) => ok && refresh());

  const copy = async () => {
    const current = link();
    if (!current) return;
    setCopied(await platform.clipboard.write(current.url));
  };

  return (
    <Panel>
      <SectionHead
        title={m().backoffice.sections.devices}
        actions={<Button onClick={openAdd}>{m().backoffice.add}</Button>}
      />

      <QueryView pending={devices.isPending} error={devices.error} data={devices.data}>
        {(rows) => (
          <Show when={rows.length > 0} fallback={<Empty />}>
            <div class="list">
              <For each={rows}>
                {(device) => {
                  /*
                   * The tablet this screen is being read on. It gets a badge and
                   * loses its Sign out button — the Worker refuses that call
                   * anyway, and a control that always fails is worse than no
                   * control: the manager would be one tap from signing
                   * themselves out mid-sentence if it ever stopped refusing.
                   */
                  const isSelf = () => device.id === app.identity()?.deviceId;

                  return (
                    <ListRow
                      title={device.name}
                      meta={
                        <>
                          <Show
                            when={device.claimedAt}
                            fallback={<Badge tone="warn">{m().devices.waiting}</Badge>}
                          >
                            {(claimedAt) => <span>{m().devices.claimedOn(app.dateTime(claimedAt()))}</span>}
                          </Show>
                          <Show when={device.hasPendingLink}>
                            <Badge tone="warn">{m().devices.linkPending}</Badge>
                          </Show>
                          <Show when={isSelf()}>
                            <Badge tone="ok">{m().devices.thisTablet}</Badge>
                          </Show>
                        </>
                      }
                      actions={
                        <>
                          <Button
                            variant="text"
                            disabled={action.busy()}
                            onClick={() => mint(device)}
                          >
                            {m().devices.newLink}
                          </Button>
                          <Show when={!isSelf()}>
                            <ConfirmButton
                              headline={m().devices.signOutHeadline}
                              body={m().devices.signOutBody(device.name)}
                              confirmLabel={m().devices.signOut}
                              disabled={action.busy()}
                              onConfirm={() => void revoke(device)}
                            >
                              {m().devices.signOut}
                            </ConfirmButton>
                          </Show>
                        </>
                      }
                    />
                  );
                }}
              </For>
            </div>
          </Show>
        )}
      </QueryView>

      <FormDialog
        open={adding()}
        onClose={() => setAdding(false)}
        headline={m().backoffice.sections.devices}
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
      </FormDialog>

      {/*
        The link, shown once.

        It is a plain dialog rather than a form: there is nothing to submit, and
        the only thing to do with it is read it out or copy it. The URL is in a
        `.selectable` box because copying can be refused — Safari wants a
        gesture, some webviews block it outright — and selecting the text by
        hand has to be the way that always works.
      */}
      <Dialog
        open={link() !== null}
        onClose={() => setLink(null)}
        headline={m().devices.linkHeadline}
        actions={
          <>
            <Button variant="text" onClick={() => setLink(null)}>
              {m().app.close}
            </Button>
            <Button onClick={() => void copy()}>
              {copied() ? m().devices.copied : m().devices.copy}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: 'var(--pos-gap)' }}>
          <Show when={link()}>
            {(current) => (
              <>
                <p class="screen-body" style={{ margin: '0' }}>
                  {current().deviceName}
                </p>
                <div class="link-box selectable">{current().url}</div>
              </>
            )}
          </Show>
          <p class="screen-body" style={{ margin: '0' }}>
            {m().devices.linkBody}
          </p>
        </div>
      </Dialog>
    </Panel>
  );
}
