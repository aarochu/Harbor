/**
 * Profile a repository from the command line.
 *
 *   npm run profile -- https://github.com/owner/repo
 *
 * M1 is the one part of Harbor that needs no model credentials, no Render
 * account and no database: a public repo clones anonymously. So this exists to
 * prove the detection half of the system works on demand, independently of
 * whatever is blocked, and to sanity-check a candidate demo repo before it is
 * ever put in front of the agent.
 */
import { profileRepo } from './profile.js'
import { toModelProfile } from './tools.js'

const [repoUrl, branch] = process.argv.slice(2)

if (repoUrl === undefined) {
  console.error('usage: npm run profile -- <github-url> [branch]')
  process.exit(1)
}

try {
  const profile = await profileRepo(repoUrl, branch === undefined ? {} : { branch })

  console.log(JSON.stringify(toModelProfile(profile), null, 2))

  if (profile.warnings.length > 0) {
    console.error(`\n[harbor] ${String(profile.warnings.length)} warning(s):`)
    for (const warning of profile.warnings) console.error(`  - ${warning}`)
  }
} catch (error) {
  console.error(`[harbor] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
