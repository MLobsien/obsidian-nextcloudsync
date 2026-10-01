import { ConfigSyncCategories, DavSyncSettings } from '../types';
import { LocalAdapter } from '../data/LocalAdapter';

/**
 * Fixed allowlist of known Obsidian core-plugin config filenames (relative to the config dir)
 * claimed by the "Core plugin settings" category. A fixed allowlist (not a denylist of
 * "everything uncategorized") is used deliberately so device-specific files like
 * `workspace.json` and unknown/community-origin files are never swept in.
 *
 * `bookmarks.json` is intentionally absent — it is owned by the dedicated Bookmarks category
 * (single ownership). This is a data list: it can be extended in one place as Obsidian ships
 * new core plugins, with no logic change.
 */
export const CORE_PLUGIN_CONFIG_FILES: readonly string[] = [
  'core-plugins.json',
  'core-plugins-migration.json',
  'graph.json',
  'daily-notes.json',
  'templates.json',
  'note-composer.json',
  'command-palette.json',
  'zk-prefixer.json',
  'random-note.json',
  'outgoing-links.json',
  'backlink.json',
  'page-preview.json',
  'file-recovery.json',
  'sync.json',
  'canvas.json',
  'switcher.json',
  'slash-command.json',
  'properties.json',
  'tag-pane.json',
  'outline.json',
  'word-count.json',
  'audio-recorder.json',
  'slides.json',
  'markdown-importer.json',
  'file-explorer.json',
  'global-search.json',
  'starred.json',
  'workspaces.json',
];

/** One config-sync category: a UI-facing label/description plus a pure path matcher. */
export interface ConfigSyncCategoryDescriptor {
  key: keyof ConfigSyncCategories;
  label: string;
  description: string;
  /** True when `rel` (a path relative to the config dir) belongs to this category. */
  matches(rel: string): boolean;
}

/**
 * The two config-sync categories (feature 029: Bookmarks + Other settings). This single list drives
 * BOTH the include decision (iterate enabled categories) and the settings UI (one toggle per
 * descriptor), so the UI and the sync logic cannot drift apart. "Other settings" folds together the
 * former appearance / themes-snippets / hotkeys / core-plugins categories.
 */
export const CONFIG_SYNC_CATEGORIES: readonly ConfigSyncCategoryDescriptor[] = [
  {
    key: 'bookmarks',
    label: 'Bookmarks',
    description: 'Obsidian bookmarks (bookmarks.json).',
    matches: (rel) => rel === 'bookmarks.json',
  },
  {
    key: 'others',
    label: 'Other settings (appearance, themes, hotkeys, core plugins)',
    description: 'Appearance & base settings (appearance.json, app.json), themes and CSS snippets (themes/, snippets/), hotkeys (hotkeys.json), and core-plugin settings (core-plugins.json, graph.json, etc.). A restart may be needed on the other device to apply core-plugin changes.',
    matches: (rel) =>
      rel === 'appearance.json' || rel === 'app.json'
      || rel.startsWith('themes/') || rel.startsWith('snippets/')
      || rel === 'hotkeys.json'
      || CORE_PLUGIN_CONFIG_FILES.includes(rel),
  },
  {
    key: 'rest',
    label: 'Rest of config folder (fork: catch-all incl. workspace etc.)',
    description: 'Fork patch: syncs every remaining file under the config folder not covered by the allowlist categories (e.g. workspace.json, workspace-mobile.json). The sync plugin itself is always excluded.',
    matches: () => true, // catch-all; hard exclusion of this plugin's own dir is applied separately
  },
];

export interface ConfigSyncResolverOptions {
  /** Vault#configDir, e.g. `.obsidian` (user-relocatable). All paths resolve against this. */
  configDir: string;
  /** Live settings reference (read on every call, so toggles take effect without a rebuild). */
  settings: Pick<DavSyncSettings, 'syncConfigFolder' | 'configSync'>;
  /**
   * This plugin's own directory (`<configDir>/plugins/<id>`), holding the sync-state DB and
   * data.json. A hard exclusion — never synced. (Already covered by the `plugins/` rule, but
   * kept explicit as defense-in-depth per FR-004.)
   */
  pluginDir: string;
  /** Used only by `enumerateIncludedPaths` to list/stat included files. */
  localAdapter: Pick<LocalAdapter, 'list' | 'stat'>;
}

/**
 * Single source of truth for "does this config-folder path sync, and which config paths should
 * be injected into the local scan". `SyncEngine.isSystemExcluded`, the remote-file filter, and
 * the remote-deletion scope guard all consult `isIncluded`, so exclusion (and the FR-008 safety
 * guarantee) is defined in exactly one place.
 */
export class ConfigSyncResolver {
  constructor(private readonly opts: ConfigSyncResolverOptions) {}

  /** Path relative to configDir, or null if `path` is not under (or equal to) the config dir. */
  private rel(path: string): string | null {
    const cd = this.opts.configDir;
    if (path === cd) return '';
    const prefix = `${cd}/`;
    if (!path.startsWith(prefix)) return null;
    return path.slice(prefix.length);
  }

  /** True if `path` is the config dir itself or anything under it. */
  isUnderConfigDir(path: string): boolean {
    return this.rel(path) !== null;
  }

  private isUnderPluginDir(path: string): boolean {
    const pd = this.opts.pluginDir;
    return path === pd || path.startsWith(`${pd}/`);
  }

  /**
   * Whether a config-folder path is included in the sync given current settings. Pure (no I/O).
   * Hard exclusions (plugins/, the plugin dir) are evaluated before category matching, so no
   * toggle combination can ever include community-plugin code or the sync-state DB.
   */
  isIncluded(path: string): boolean {
    const rel = this.rel(path);
    if (rel === null) return false;                 // not under configDir
    if (rel === '') return false;                   // the dir itself is not a file
    if (!this.opts.settings.syncConfigFolder) return false; // C1: master off
    // C2: hard exclusions win over every category toggle. Fork patch: the `plugins/` exclusion
    // was removed — community plugins are now syncable. Only this plugin's own dir (state DB,
    // data.json) stays excluded.
    if (this.isUnderPluginDir(path)) return false;
    // Fork patch: sync the whole config dir. Only ignore this plugin's own dir; everything else
    // under the config dir is syncable. Return true for any config path (unless the hard
    // pluginDir exclusion above has fired).
    return !!this.opts.settings.syncConfigFolder;
  }

  /** True iff `path` is an included config-folder file (used to route conflicts to newest-wins). */
  isConfigFolderConflictPath(path: string): boolean {
    return this.isUnderConfigDir(path) && this.isIncluded(path);
  }

  /**
   * Concrete config-folder paths to inject into the local scan. Enumerates only what is in
   * scope — fixed files that exist + a recursive listing of themes/ and snippets/. Never lists
   * `plugins/`. Every returned path P satisfies `isIncluded(P) === true`.
   */
  async enumerateIncludedPaths(): Promise<string[]> {
    // Fork patch: sync the whole config dir. Enumerate everything except this plugin's own dir.
    if (!this.opts.settings.syncConfigFolder) return [];
    const out: string[] = [];
    try {
      const listing = await this.opts.localAdapter.list(this.opts.configDir);
      for (const f of listing.files) out.push(f);
      for (const sub of listing.folders) {
        if (sub === this.opts.pluginDir || sub.startsWith(`${this.opts.pluginDir}/`)) continue;
        await this.listRecursive(sub, out);
      }
    } catch {
      /* config dir absent or unreadable — nothing to inject */
    }
    return Array.from(new Set(out));
  }

  private async listRecursive(dir: string, out: string[]): Promise<void> {
    try {
      const listing = await this.opts.localAdapter.list(dir);
      for (const f of listing.files) out.push(f);
      for (const sub of listing.folders) await this.listRecursive(sub, out);
    } catch {
      /* directory absent or unreadable — nothing to inject */
    }
  }
}
