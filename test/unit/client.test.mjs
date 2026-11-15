import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * Load the client bundle the way the Host does: set the module-loader global,
 * import the file, and capture the factory it registers.
 */
async function loadClientFactory() {
  let factory;
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory: registered }) => {
        assert.equal(id, 'dsh-loci', 'the bundle id must be the package name');
        factory = registered;
      },
    },
  };
  const react = {
    createElement: () => null,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useMemo: () => undefined,
    useCallback: (fn) => fn,
    useRef: () => ({ current: undefined }),
  };
  await import('../../client.js');
  assert.equal(typeof factory, 'function', 'client.js must register a factory');
  return factory((specifier) => {
    assert.equal(specifier, 'react', 'only react comes from the shell module table');
    return react;
  });
}

/** Run `apply` against a minimal client context and collect registrations. */
function mount(plugin) {
  const registrations = [];
  const localeCalls = [];
  const effects = [];
  const ctx = {
    effect: (factory) => {
      effects.push(factory);
      const disposer = factory();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    locale: {
      register: (ns, dict) => {
        localeCalls.push({ ns, dict });
        return () => {};
      },
      bind: () => (key) => key,
    },
    slots: {
      inject: (slot, register) => {
        registrations.push({ slot });
        // The Host runs the installer when the owning declaration appears.
        register();
        return () => {};
      },
      register: (options, Component) => {
        registrations.at(-1).options = options;
        registrations.at(-1).component = Component;
        return () => {};
      },
    },
    layout: { selectPanel: () => {} },
    get: () => undefined,
  };
  plugin.apply(ctx);
  return { registrations, localeCalls, effects, ctx };
}

test('the client half registers the sidebar mirror, the panel, and the settings page', async () => {
  const plugin = await loadClientFactory();
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'layout']);
  assert.equal(typeof plugin.apply, 'function');

  const { registrations, localeCalls, effects } = mount(plugin);

  assert.equal(localeCalls.length, 1);
  assert.equal(localeCalls[0].ns, 'loci');
  // English only, on purpose: a second dictionary is what made the product have a
  // language at all, and the UI was showing Chinese purely because the browser locale
  // resolved to zh.
  assert.deepEqual(Object.keys(localeCalls[0].dict), ['en'], 'only the English dictionary is registered');
  for (const key of ['card.title', 'panel.feed', 'settings.budget', 'action.added']) {
    assert.ok(localeCalls[0].dict.en[key], `en dictionary is missing ${key}`);
  }

  // Every registration ran inside an effect, so unload removes it.
  for (const factory of effects) factory();

  assert.deepEqual(
    registrations.map((entry) => entry.slot),
    ['sidebar.footer.action', 'settings.section', 'settings.section.icon', 'sidebar.panellist', 'main'],
  );

  // The "mirror" card sits beside Settings, as requested.
  const card = registrations[0].options;
  assert.equal(card.name, 'sidebar.footer.action');
  assert.equal(card.id, 'loci-card');
  assert.equal(typeof card.order, 'number');
  assert.equal(typeof card.label, 'function');
  assert.equal(typeof registrations[0].component, 'function');

  const settings = registrations[1].options;
  assert.equal(settings.id, 'loci');

  const panelIcon = registrations[3].options;
  assert.equal(panelIcon.id, 'loci', 'the sidebar id must address the main panel');

  const main = registrations[4].options;
  assert.equal(main.key, 'loci', 'the main slot is keyed by the sidebar id');

  for (const entry of registrations) {
    assert.equal(typeof entry.component, 'function', `${entry.slot} must register a component`);
  }
});

test('the bundle exposes English display metadata and no second language', async () => {
  const { existsSync, readFileSync } = await import('node:fs');
  const en = JSON.parse(readFileSync(new URL('../../locale/en.json', import.meta.url), 'utf8'));
  assert.ok(en.meta.title.includes('Loci'));
  assert.ok(en.meta.description.length > 20);
  // The plugin ships one language. A `zh.json` here would put Chinese back into the
  // marketplace listing and the settings sidebar without anyone editing client.js.
  assert.equal(existsSync(new URL('../../locale/zh.json', import.meta.url)), false);
});
