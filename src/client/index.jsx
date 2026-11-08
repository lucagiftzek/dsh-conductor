/**
 * dsh-conductor, browser half (bundled by scripts/build.mjs into lib/client.js).
 *
 *   1. The "Conductor" tab on dsh-better-sidebar (ctx.betterSidebar.registerTab):
 *      a compact header (context numbers, New context, resets) and the
 *      sub-tabs Context, Pins, Inbox, History and Agents.
 *   2. In the main chat (chat.jsx): ghosts (silent posts) as message bubbles,
 *      edited messages showing their current version with a "v2" marker,
 *      and a star in every finished answer's action row to pin it.
 *   3. Slash command actions (ctx.commandUi): a bare /drop opens Context;
 *      /pins, /inbox, /versions and /conductor open their sub-tab.
 *   4. The Conductor section of the Settings page (slot settings.section).
 *
 * Every optional service is guarded: a missing one logs one warning and the
 * rest keeps working. Colours come only from theme tokens (styles.js).
 */
import React from 'react'
import { ConductorTab, SECTION_IDS } from './tab.jsx'
import { PinStar } from './star.jsx'
import { registerGhostDefinition, registerChatRenderers, AssistantVersionAction } from './chat.jsx'
import { SettingsSection } from './settings.jsx'
import { Icon, useSignal } from './ui.jsx'
import { ensureStyles } from './styles.js'
import { TAB_ID, badgeFor, requestSection, refreshSettings, moduleOn, settingsModel } from './store.js'

export const name = 'dsh-conductor'
export const inject = ['betterSidebar', 'slots', 'locale']

const warn = (message, error) => console.warn('[dsh-conductor] ' + message + (error ? ': ' + String((error && error.message) || error) : ''))

/** Client commands that open the tab on one section. */
export const SECTION_COMMANDS = [
  { name: 'conductor', section: 'context', label: 'Conductor', description: 'Open the Conductor tab: context, pins, inbox and agents' },
  { name: 'pins', section: 'pins', label: 'Pins', description: 'Show pinned messages in Conductor' },
  { name: 'inbox', section: 'inbox', label: 'Inbox', description: 'Show silent messages from other chats' },
  { name: 'versions', section: 'history', label: 'Versions', description: 'Show edited messages and their versions in History' },
]

/** Register on a DSH effect when available, else call directly (tests, old hosts). */
function effect(ctx, fn, label) {
  try {
    if (typeof ctx.effect === 'function') return ctx.effect(fn, label)
    return fn()
  } catch (error) {
    warn(label + ' failed', error)
    return undefined
  }
}

export function tabDescriptor(sidebar, services) {
  return {
    id: TAB_ID,
    title: 'Conductor',
    description: 'Context meter, drops, pins, inbox, resets and agents for this chat.',
    order: 85,
    single: true,
    icon: (size) => Icon.conductor(size || 16),
    badge: (_ctx, scope) => badgeFor(scope && scope.sessionId),
    component: (props) => (
      <ConductorTab sessionId={props && props.scope && typeof props.scope.sessionId === 'string' ? props.scope.sessionId : null}
        visible={Boolean(props && props.visible)} store={props && props.store} tab={props && props.tab} tabId={TAB_ID} services={services} />
    ),
    settings: {
      pluginToggles: [
        { key: 'autoPoll', type: 'switch', title: 'Poll while visible', desc: 'Refresh Conductor every few seconds while the tab is open.' },
        { key: 'undoSeconds', type: 'number', min: 5, max: 30, unit: 's', title: 'Undo window', desc: 'How long Undo stays available after a drop, unpin or dismiss.' },
        { key: 'warnPercent', type: 'number', min: 50, max: 95, unit: '%', title: 'Context warning', desc: 'Show a hint when the context is fuller than this.' },
        { key: 'inboxBadge', type: 'switch', title: 'Count unread inbox in the tab badge', desc: 'Turn off to count only running agents and tasks.' },
        { key: 'autoOpenInbox', type: 'switch', title: 'Open Inbox when something new arrives', desc: 'Expands the section, never steals focus.' },
      ],
    },
  }
}

/** Open the Conductor tab of a chat on one section. */
export function openSection(sidebar, sessionId, section) {
  if (!SECTION_IDS.includes(section)) section = 'context'
  requestSection(sessionId, section)
  if (!sidebar || typeof sidebar.openTab !== 'function') {
    warn('Better Sidebar is unavailable; cannot open the Conductor tab')
    return false
  }
  try {
    sidebar.openTab({ type: TAB_ID, target: 'right', reveal: true, meta: { section, at: Date.now() } }, sessionId ? { sessionId } : undefined)
    return true
  } catch (error) {
    warn('could not open the Conductor tab', error)
    return false
  }
}

export function apply(ctx) {
  const sidebar = ctx.betterSidebar && typeof ctx.betterSidebar.registerTab === 'function' ? ctx.betterSidebar : null
  let workspace = null
  let sessionsService = null
  /**
   * Put text in a chat's input box through the conversation input facade
   * (SessionInput.setDraft). Returns false when this DSH build offers no way.
   */
  const putDraft = (sessionId, text) => {
    try {
      const binding = sessionsService && typeof sessionsService.binding === 'function' ? sessionsService.binding(sessionId) : null
      const bctx = binding && binding.ctx
      const conversation = bctx && typeof bctx.get === 'function' ? bctx.get('conversation') : null
      const input = conversation && conversation.input && typeof conversation.input.for === 'function' ? conversation.input.for(bctx) : null
      if (!input || typeof input.setDraft !== 'function') return false
      input.setDraft(String(text))
      if (typeof input.focus === 'function') input.focus()
      return true
    } catch (error) {
      warn('could not put the prompt back in the input box', error)
      return false
    }
  }
  const services = { sidebar, workspace: () => workspace, putDraft: () => (sessionsService ? putDraft : null) }
  const openFromChat = (sessionId, section) => openSection(sidebar, sessionId, section)

  // 1. the sidebar tab
  if (!sidebar) {
    console.error('[dsh-conductor] ctx.betterSidebar.registerTab is unavailable; the Conductor tab is not registered')
  } else {
    effect(ctx, () => sidebar.registerTab(tabDescriptor(sidebar, services)), 'dsh-conductor: register the Conductor tab')
  }

  const slots = ctx.slots && typeof ctx.slots.inject === 'function' && typeof ctx.slots.register === 'function' ? ctx.slots : null
  if (!slots) warn('ctx.slots unavailable; the settings section and the message star are not registered')

  // 2. the star in the assistant message action row
  if (slots) {
    effect(ctx, () => slots.inject('conversation.chat.assistant-actions', () => slots.register({
      name: 'conversation.chat.assistant-actions',
      id: 'dsh-conductor-pin',
      order: 20,
      inject: (sessionId) => ({ sessionId }),
    }, function ConductorPinAction(props) {
      useSignal(settingsModel)
      if (!moduleOn('pins')) return null
      return <PinStar messageId={props && props.messageId} sessionId={props && props.sessionId} />
    })), 'dsh-conductor: message star')
    // the version marker of an edited answer, beside the star
    effect(ctx, () => slots.inject('conversation.chat.assistant-actions', () => slots.register({
      name: 'conversation.chat.assistant-actions',
      id: 'dsh-conductor-version',
      order: 21,
      inject: (sessionId) => ({ sessionId }),
    }, function ConductorVersionAction(props) {
      return <AssistantVersionAction messageId={props && props.messageId} sessionId={props && props.sessionId} openSection={openFromChat} />
    })), 'dsh-conductor: version marker')
    // ghosts and edited messages in the main chat
    registerChatRenderers(ctx, slots, effect, warn, openFromChat)
  }

  // 4. the settings page section
  if (slots) {
    effect(ctx, () => slots.inject('settings.section', () => slots.register({
      name: 'settings.section',
      id: 'dsh-conductor',
      order: 96,
      label: () => 'Conductor',
      inject: () => ({}),
    }, function ConductorSettingsSlot() {
      React.useEffect(() => { ensureStyles() }, [])
      return <SettingsSection />
    })), 'dsh-conductor: settings section')
  }

  // 3. slash commands and navigation (optional services, injected lazily)
  if (typeof ctx.inject !== 'function') {
    warn('ctx.inject unavailable; slash command actions and chat navigation are off')
    return
  }
  try {
    ctx.inject(['uiWorkspace'], (scope) => {
      try {
        workspace = scope.get ? scope.get('uiWorkspace') : scope.uiWorkspace
      } catch (error) { warn('uiWorkspace unavailable', error) }
      effect(scope, () => () => { workspace = null }, 'dsh-conductor: workspace handle')
    })
  } catch (error) { warn('uiWorkspace injection failed', error) }

  try {
    ctx.inject(['sessions'], (scope) => {
      try { sessionsService = scope.get ? scope.get('sessions') : scope.sessions } catch (error) { warn('sessions unavailable', error) }
      effect(scope, () => () => { sessionsService = null }, 'dsh-conductor: sessions handle')
    })
  } catch (error) { warn('sessions injection failed', error) }

  try {
    ctx.inject(['uiConversation'], (scope) => {
      let ui = null
      try { ui = scope.get ? scope.get('uiConversation') : scope.uiConversation } catch (error) { warn('uiConversation unavailable', error) }
      registerGhostDefinition(ui, scope, effect, warn)
    })
  } catch (error) { warn('uiConversation injection failed', error) }

  try {
    ctx.inject(['commandUi'], (scope) => {
      let commands = null
      try { commands = scope.get ? scope.get('commandUi') : scope.commandUi } catch (error) { warn('commandUi unavailable', error) }
      if (!commands) return
      const canOpen = () => Boolean(sidebar)
      if (typeof commands.decorate === 'function') {
        effect(scope, () => commands.decorate({
          name: 'drop',
          available: () => canOpen() && moduleOn('context'),
          ui: { kind: 'action', run: (session) => { openSection(sidebar, session && session.sessionId, 'context') } },
        }), 'dsh-conductor: /drop opens the Context inspector')
      }
      if (typeof commands.register === 'function') {
        for (const c of SECTION_COMMANDS) {
          effect(scope, () => commands.register({
            name: c.name,
            label: () => c.label,
            description: () => c.description,
            available: () => canOpen() && (c.section === 'pins' ? moduleOn('pins') : c.section === 'inbox' ? moduleOn('posts') : c.name === 'versions' ? moduleOn('versions') : true),
            ui: { kind: 'action', run: (session) => { openSection(sidebar, session && session.sessionId, c.section) } },
          }), 'dsh-conductor: /' + c.name)
        }
      }
    })
  } catch (error) { warn('commandUi injection failed', error) }

  // module switches gate the star and the commands: learn them early
  refreshSettings()
}
