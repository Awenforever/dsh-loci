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
  const module = await import('../../client.js');
  void module;
  assert.equal(typeof factory, 'function', 'client.js must register a factory');
  return factory((specifier) => {
    assert.equal(specifier, 'react', 'only react comes from the shell module table');
    return react;
  });
}

test('the client half registers a settings page and a sidebar panel', async () => {
  const plugin = await loadClientFactory();
  assert.deepEqual(plugin.inject, ['slots', 'locale']);
  assert.equal(typeof plugin.apply, 'function');

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
    get: () => undefined,
  };

  plugin.apply(ctx);

  assert.equal(localeCalls.length, 1);
  assert.equal(localeCalls[0].ns, 'loci');
  assert.ok(localeCalls[0].dict.zh['panel.title']);
  assert.ok(localeCalls[0].dict.en['panel.title']);

  // Every registration ran inside an effect, so unload removes it.
  for (const factory of effects) factory();

  const slots = registrations.map((entry) => entry.slot);
  assert.deepEqual(slots, ['settings.section', 'settings.section.icon', 'sidebar.panellist', 'main']);

  const settings = registrations[0].options;
  assert.equal(settings.name, 'settings.section');
  assert.equal(settings.id, 'loci');
  assert.equal(typeof settings.order, 'number');
  assert.equal(typeof settings.label, 'function');

  const panel = registrations[2].options;
  assert.equal(panel.id, 'loci', 'the sidebar id must address the main panel');

  const main = registrations[3].options;
  assert.equal(main.key, 'loci', 'the main slot is keyed by the sidebar id');

  for (const entry of registrations) {
    assert.equal(typeof entry.component, 'function', `${entry.slot} must register a component`);
  }
});

test('the bundle exposes localized display metadata', async () => {
  const { readFileSync } = await import('node:fs');
  const en = JSON.parse(readFileSync(new URL('../../locale/en.json', import.meta.url), 'utf8'));
  const zh = JSON.parse(readFileSync(new URL('../../locale/zh.json', import.meta.url), 'utf8'));
  assert.ok(en.meta.title.includes('Loci'));
  assert.ok(zh.meta.title.includes('Loci'));
  assert.ok(en.meta.description.length > 20);
});
