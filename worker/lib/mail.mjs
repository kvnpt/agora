// Email: telling people what happened to something that waited on somebody
// else.
//
// Two messages, both about a claim ("Become a parish contact"): the owners
// hear that one was made, and the claimant hears what was decided. Before
// this, a claimant found out only by signing in again, and an owner only from
// the red dot (docs/roadmap.md, phase 2).
//
// CLOUDFLARE'S OWN SENDING, NOT A THIRD PARTY. The `send_email` binding
// (Email Sending) needs no API key stored anywhere, the same reason deploys
// go through Workers Builds rather than a token. What it needs instead is
// account set-up: the Workers Paid plan to reach any address (on Free it
// reaches only addresses verified in Email Routing), and orthodoxy.au
// onboarded as a sending domain. docs/people-and-access.md has the steps.
//
// OPTIONAL, like the poster reader's key. With no `EMAIL` binding nothing is
// sent and nothing else changes. A send that fails is logged and swallowed:
// an approval is a write to admin_roles, and an email that bounces must
// never undo it or turn it into an error on the owner's screen.
//
// No addresses in the logs: a line says what was sent and how many, not to
// whom.

/** Who the mail is from. Its domain must be onboarded to Email Sending. */
export const MAIL_FROM = 'noreply@orthodoxy.au';

/** An identity Access gave that can take an email — not a bare `sub`, not 'dev'. */
export const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

/** May this deployment send at all? */
export const canMail = (env) => !!(env && env.EMAIL && typeof env.EMAIL.send === 'function');

/**
 * Send one plain-text message to each address, separately — so no recipient
 * sees the others. Never throws.
 *
 * @returns {Promise<{ sent: number, skipped?: string, failed?: string[] }>}
 */
export async function sendMail(env, { to, subject, text }) {
  const list = [...new Set((Array.isArray(to) ? to : [to]).filter(isEmail).map(a => a.trim()))];
  if (!canMail(env)) return { sent: 0, skipped: 'not-configured' };
  if (!list.length) return { sent: 0, skipped: 'no-recipient' };
  let sent = 0;
  const failed = [];
  for (const address of list) {
    try {
      await env.EMAIL.send({ from: { email: env.MAIL_FROM || MAIL_FROM, name: 'orthodoxy.au' }, to: address, subject, text });
      sent++;
    } catch (e) {
      failed.push((e && e.code) || 'error');
    }
  }
  const line = { mail: { subject, sent, ...(failed.length ? { failed } : {}) } };
  if (failed.length) console.error(JSON.stringify(line));
  else console.log(JSON.stringify(line));
  return failed.length ? { sent, failed } : { sent };
}

const sign = '\n— orthodoxy.au\n';

/** To the owners: somebody asked to keep a parish. */
export function claimFiledMail(claim, parish, origin) {
  const who = claim.relation ? `${claim.name} (${claim.relation})` : claim.name;
  return {
    subject: `${claim.name} asks to keep ${parish.name}`,
    text: [
      `${who}, ${claim.email}, asks to become a parish contact for ${parish.name}.`,
      claim.phone ? `Phone: ${claim.phone}` : null,
      claim.note ? `\n“${claim.note}”` : null,
      `\nApprove or decline it under Asks:\n${origin}/admin#proposals`,
      sign,
    ].filter(v => v !== null).join('\n'),
  };
}

/**
 * To the claimant: what was decided. An approval links to the Suggest edits
 * page, which is behind Access — so it signs them in on the way — and, for
 * somebody who may now edit the parish, says so and opens it.
 */
export function claimDecidedMail(claim, parish, { approved, note }, origin) {
  const link = `${origin}/admin?suggest=${encodeURIComponent(parish.id)}`;
  const page = `${origin}/${encodeURIComponent(String(parish.acronym || parish.id).toLowerCase())}`;
  if (approved) {
    return {
      subject: `You can now keep ${parish.name} up to date`,
      text: [
        `Your request to become a parish contact for ${parish.name} has been approved.`,
        `\nSign in with this email address and the parish's page has a pencil on its details, its service times and its events:\n${link}`,
        note ? `\nA note from the site owner: “${note}”` : null,
        sign,
      ].filter(v => v !== null).join('\n'),
    };
  }
  return {
    subject: `About your request for ${parish.name}`,
    text: [
      `Your request to become a parish contact for ${parish.name} was not approved.`,
      note ? `\nThe site owner wrote: “${note}”` : null,
      `\nYou can still suggest changes from the parish's page, and whoever keeps it will see them:\n${page}`,
      sign,
    ].filter(v => v !== null).join('\n'),
  };
}
