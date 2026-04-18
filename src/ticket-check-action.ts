import { debug as log, getInput, setFailed } from '@actions/core';
import { context, getOctokit } from '@actions/github';

// Central list of GitHub usernames exempt from automatic PR title rewrites.
// Kept in source (not a per-repo input) so configuration lives in one place
// instead of every consuming repo implementing and maintaining its own
// exemption list. Validation still applies — exempt users must put a ticket
// reference in the PR title or CI fails.
// NOTE: This differs from upstream neofinancial behavior (which exempts users
// from validation entirely and is configured per-repo via an `exemptUsers`
// input). The `exemptUsers` input has been removed in this fork.
const EXEMPT_USERS = ['sumeet-bansal'];

// Helper function to retrieve ticket number from a regex match.
// Prefers the named capture group `ticketNumber` from the regex match,
// then falls back to extracting the first digit sequence from the matched substring.
const extractIdFromMatch = (match: RegExpExecArray): string | null => {
  const fromGroup = match.groups?.ticketNumber;

  if (fromGroup) {
    return fromGroup;
  }

  const result = match[0].match(/\d+/);

  if (result !== null) {
    return result[0];
  }

  return null;
};

const debug = (label: string, message: string): void => {
  log('');
  log(`[${label.toUpperCase()}]`);
  log(message);
  log('');
};

const buildNewTitle = (titleFormat: string, id: string, title: string, ticketPrefix: string): string => {
  let newTitle =
    titleFormat.includes('%id%') && id && !title.includes(id)
      ? titleFormat.replace('%id%', id)
      : titleFormat.replace('%id%', '');

  newTitle =
    titleFormat.includes('%prefix%') && ticketPrefix && !title.includes(ticketPrefix)
      ? newTitle.replace('%prefix%', ticketPrefix)
      : newTitle.replace('%prefix%', '');

  // If both prefix and id are already present in the title, leave it alone.
  if (title.includes(ticketPrefix) && title.includes(id)) {
    return title;
  }

  return newTitle.replace('%title%', title);
};

export async function run(): Promise<void> {
  try {
    debug('context', JSON.stringify(context));

    const title: string = context?.payload?.pull_request?.title;
    const body: string | undefined = context?.payload?.pull_request?.body;
    const branch: string = context.payload.pull_request?.head.ref;
    const login = context.payload.pull_request?.user.login as string;
    const senderType = context.payload.pull_request?.user.type as string;
    const sender: string = senderType === 'Bot' ? login.replace('[bot]', '') : login;

    const token = getInput('token', { required: true });
    const client = getOctokit(token);
    const { owner, repo, number } = context.issue;

    const quiet = getInput('quiet', { required: false }) === 'true';
    const ticketLink = getInput('ticketLink', { required: false });
    const ticketPrefix = getInput('ticketPrefix');
    const titleFormat = getInput('titleFormat', { required: true });

    const isExemptFromRewrite = Boolean(sender) && EXEMPT_USERS.includes(sender);

    debug('sender', sender);
    debug('sender type', senderType);
    debug('quiet mode', quiet.toString());
    debug('exempt from rewrite', isExemptFromRewrite.toString());
    debug('ticket link', ticketLink);

    const titleRegex = new RegExp(
      getInput('titleRegex', { required: true }),
      getInput('titleRegexFlags', { required: true }),
    );
    const titleCheck = titleRegex.exec(title);

    const linkTicket = async (matchArray: RegExpMatchArray): Promise<void> => {
      debug('match array for linkTicket', JSON.stringify(matchArray));
      debug('match array groups for linkTicket', JSON.stringify(matchArray.groups));

      if (!ticketLink) {
        return;
      }

      const ticketNumber = matchArray.groups?.ticketNumber;

      if (!ticketNumber) {
        debug('ticketNumber not found', 'ticketNumber group not found in match array.');

        return;
      }

      if (!ticketLink.includes('%ticketNumber%')) {
        debug('invalid ticketLink', 'ticketLink must include "%ticketNumber%" variable to post ticket link.');

        return;
      }

      const linkToTicket = ticketLink.replace('%ticketNumber%', ticketNumber);

      const currentReviews = await client.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: number,
      });

      debug('current reviews', JSON.stringify(currentReviews));

      if (
        currentReviews?.data?.length &&
        currentReviews?.data.some((review: { body?: string }) => review?.body?.includes(linkToTicket))
      ) {
        debug('already posted ticketLink', 'found an existing review that contains the ticket link');

        return;
      }

      client.rest.pulls.createReview({
        owner,
        repo,
        pull_number: number,
        body: `See the ticket for this pull request: ${linkToTicket}`,
        event: 'COMMENT',
      });
    };

    // Validation is strictly title-based: the PR title must reference a ticket.
    // If it does, we pass.
    if (titleCheck !== null) {
      debug('success', 'Title includes a ticket ID');
      await linkTicket(titleCheck);

      return;
    }

    debug('title', title);

    // Title does not reference a ticket — this run will fail. For non-exempt
    // users, attempt to rewrite the title using branch name, body, or body URL
    // as a source (in that order). The rewrite triggers a PR `edited` event
    // which re-runs this workflow; the next run then passes on the new title.
    if (!isExemptFromRewrite) {
      const branchRegex = new RegExp(
        getInput('branchRegex', { required: true }),
        getInput('branchRegexFlags', { required: true }),
      );
      const branchCheck = branchRegex.exec(branch);

      const bodyRegex = new RegExp(
        getInput('bodyRegex', { required: true }),
        getInput('bodyRegexFlags', { required: true }),
      );
      const bodyCheck = body === undefined ? null : bodyRegex.exec(body);

      const bodyURLRegexBase = getInput('bodyURLRegex', { required: false });
      const bodyURLCheck =
        bodyURLRegexBase && body !== undefined
          ? new RegExp(bodyURLRegexBase, getInput('bodyURLRegexFlags', { required: true })).exec(body)
          : null;

      let rewriteMatch: RegExpExecArray | null = null;
      let rewriteSource = '';

      if (branchCheck !== null) {
        rewriteMatch = branchCheck;
        rewriteSource = 'branch name';
      } else if (bodyCheck !== null) {
        rewriteMatch = bodyCheck;
        rewriteSource = 'body';
      } else if (bodyURLCheck !== null) {
        rewriteMatch = bodyURLCheck;
        rewriteSource = 'body URL';
      }

      if (rewriteMatch !== null) {
        debug('rewrite', `Rewriting title from ${rewriteSource} reference`);

        const id = extractIdFromMatch(rewriteMatch);

        if (id === null) {
          debug('failure', `Could not extract ticket ID from ${rewriteSource} match`);
        } else {
          const newTitle = buildNewTitle(titleFormat, id, title, ticketPrefix);

          client.rest.pulls.update({
            owner,
            repo,
            pull_number: number,
            title: newTitle,
          });

          if (!quiet) {
            client.rest.pulls.createReview({
              owner,
              repo,
              pull_number: number,
              body: `Hey! I noticed that your PR contained a reference to the ticket in the ${rewriteSource} but not in the title. I went ahead and updated that for you. Hope you don't mind! ☺️`,
              event: 'COMMENT',
            });
          }

          await linkTicket(rewriteMatch);
        }
      }
    }

    setFailed('PR title does not reference a ticket');
  } catch (error) {
    setFailed(error.message);
  }
}
