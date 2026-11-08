/**
 * The star in an assistant message's action row (slot
 * conversation.chat.assistant-actions): pin or unpin that message. It shares
 * the per-chat view with the Conductor tab, fetched lazily the first time a
 * star renders (one request for every star of the chat) and refreshed after
 * each toggle or when the pointer comes back after 15 s.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { sessionModel } from './store.js'
import { sessionApi, errorText } from './api.js'
import { fmtTokens } from './format.js'
import { Icon, useSignal } from './ui.jsx'
import { ensureStyles } from './styles.js'
import { announce } from './toasts.jsx'

export function PinStar({ messageId, sessionId }) {
  useEffect(() => { ensureStyles() }, [])
  const model = useMemo(() => (sessionId ? sessionModel(sessionId) : null), [sessionId])
  if (!model || !messageId) return null
  return <PinStarInner messageId={messageId} sessionId={sessionId} model={model} />
}

function PinStarInner({ messageId, sessionId, model }) {
  const snap = useSignal(model)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState('')
  useEffect(() => { model.ensure(60000) }, [model])
  const pins = (snap.view && snap.view.pins) || []
  const pin = pins.find((p) => p.messageId === messageId)
  const pinned = Boolean(pin)
  const label = pinned ? 'Unpin' : 'Pin to context'

  const toggle = async () => {
    if (pending) return
    setPending(true)
    setFailure('')
    const api = sessionApi(sessionId)
    try {
      if (pinned) {
        await api.unpin(pin.id)
        announce('Unpinned. ' + fmtTokens(pin.tokens || 0) + ' tokens leave the context at the next reset.')
      } else {
        const r = await api.pin(messageId)
        announce('Pinned. ' + fmtTokens((r.pin && r.pin.tokens) || 0) + ' tokens added to context.')
      }
    } catch (e) {
      setFailure(e && e.code === 'limit' ? 'Pin limit reached. Unpin one to add another.' : (pinned ? 'Could not unpin: ' : 'Could not pin: ') + errorText(e))
    } finally {
      setPending(false)
      model.refresh().catch(() => {})
    }
  }

  return (
    <span className="cdx-star" data-conductor-star>
      <button type="button" aria-label={label} title={label} aria-pressed={pinned} disabled={pending}
        onPointerEnter={() => { model.ensure(15000) }} onFocus={() => { model.ensure(15000) }} onClick={toggle}>
        {Icon.star(15, pinned)}
      </button>
      {failure ? <span className="cdx-star-msg" role="status">{failure}</span> : null}
    </span>
  )
}
