import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_KEY;

if (!url || !anonKey || !serviceKey) {
  throw new Error("Local Supabase integration environment is missing");
}

const service = createClient(url, serviceKey, { auth: { persistSession: false } });
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const password = `Spaces-${suffix}-Aa1!`;
const referrerEmail = `referrer-${suffix}@example.com`;
const referredEmail = `referred-${suffix}@example.com`;
const blockedEmail = `blocked-${suffix}@example.com`;
const strangerEmail = `stranger-${suffix}@example.com`;
const projectInviteEmail = `project-invite-${suffix}@example.com`;
const createdUserIds = [];

function client() {
  return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

function requireData(result, operation) {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
  return result.data;
}

async function createAdminUser(email, name) {
  const data = requireData(await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  }), `create ${email}`);
  createdUserIds.push(data.user.id);
  return data.user;
}

async function signIn(email) {
  const auth = client();
  requireData(await auth.auth.signInWithPassword({ email, password }), `sign in ${email}`);
  return auth;
}

try {
  const referrer = await createAdminUser(referrerEmail, "Referrer");
  const stranger = await createAdminUser(strangerEmail, "Stranger");
  const referralCode = requireData(await service.from("referral_codes").select("code").eq("user_id", referrer.id).single(), "load referral code").code;
  assert.match(referralCode, /^[0-9a-f]{20}$/);

  const blockedSignup = await client().auth.signUp({ email: blockedEmail, password });
  assert(blockedSignup.error, "signup without a reservation must be rejected by the auth hook");

  const invalidReservation = await client().rpc("reserve_referral_signup", {
    p_email: referredEmail,
    p_code: "not-a-real-code",
  });
  assert(invalidReservation.error, "invalid referral code must be rejected server-side");

  const anonymous = client();
  requireData(await anonymous.rpc("reserve_referral_signup", {
    p_email: referredEmail,
    p_code: referralCode.toUpperCase(),
  }), "reserve referral signup");

  const signup = requireData(await anonymous.auth.signUp({
    email: referredEmail,
    password,
    options: { data: { name: "Referred" } },
  }), "referral signup");
  assert(signup.user, "referral signup must create a user");
  createdUserIds.push(signup.user.id);

  const relationship = requireData(await service.from("referrals").select("referrer_user_id,referred_user_id,source").eq("referred_user_id", signup.user.id).single(), "load referral relationship");
  assert.equal(relationship.referrer_user_id, referrer.id);
  assert.equal(relationship.source, "referral_code");

  const strangerCode = requireData(await service.from("referral_codes").select("code").eq("user_id", stranger.id).single(), "load stranger referral code").code;
  const rebindAttempt = await client().rpc("reserve_referral_signup", {
    p_email: referredEmail,
    p_code: strangerCode,
  });
  assert(rebindAttempt.error, "consumed referral attribution must not be reopened or rebound");

  const ownCode = requireData(await service.from("referral_codes").select("code").eq("user_id", signup.user.id).single(), "load referred user code");
  assert.match(ownCode.code, /^[0-9a-f]{20}$/);
  assert.notEqual(ownCode.code, referralCode);

  await anonymous.auth.signOut();
  const referrerClient = await signIn(referrerEmail);
  const overview = requireData(await referrerClient.rpc("get_my_referral_overview"), "load referral overview");
  assert.equal(overview.count, 1);
  assert.equal(overview.code, referralCode);
  assert.equal(overview.link, `https://spaces.community/register?ref=${referralCode}`);
  assert.equal(overview.invited[0].display_name, "Referred");
  assert.match(overview.invited[0].masked_email, /^r\*\*\*@example\.com$/);

  const selfReferral = await referrerClient.rpc("reserve_referral_signup", {
    p_email: referrerEmail,
    p_code: referralCode,
  });
  assert(selfReferral.error, "self-referral must be rejected");

  const ownerMembership = requireData(await service.from("account_memberships").select("account_id").eq("user_id", referrer.id).eq("role", "owner").single(), "load referrer account");
  const project = requireData(await referrerClient.rpc("create_account_project", {
    p_account_id: ownerMembership.account_id,
    project_name: `Referral invite ${suffix}`,
    project_description: null,
    project_logo_url: null,
    enabled_service_slugs: [],
  }), "create invitation project");
  const invitation = requireData(await referrerClient.rpc("create_project_invitation", {
    p_project_id: project.id,
    p_email: projectInviteEmail,
  }), "create project invitation");
  const deliveries = requireData(await service.rpc("claim_project_invitation_deliveries", { p_limit: 10 }), "claim project invitation");
  assert(deliveries.some((item) => item.invitation_id === invitation.id && !item.user_exists));
  requireData(await service.rpc("prepare_project_invitation_signup", { p_invitation_id: invitation.id }), "prepare project invitation signup");
  const invited = requireData(await service.auth.admin.generateLink({
    type: "invite",
    email: projectInviteEmail,
    options: { redirectTo: `http://127.0.0.1:4173/invite?invitation=${invitation.id}` },
  }), "generate project invitation link");
  createdUserIds.push(invited.user.id);
  const invitedRelationship = requireData(await service.from("referrals").select("referrer_user_id,source").eq("referred_user_id", invited.user.id).single(), "load project invitation referral");
  assert.equal(invitedRelationship.referrer_user_id, referrer.id);
  assert.equal(invitedRelationship.source, "project_invitation");
  requireData(await service.rpc("complete_project_invitation_delivery", {
    p_invitation_id: invitation.id,
    p_success: true,
    p_error: null,
  }), "complete project invitation delivery");

  const duplicateSignup = await client().auth.signUp({ email: referredEmail, password });
  assert(duplicateSignup.error || duplicateSignup.data.user, "repeat signup must return a controlled auth response");
  const duplicateCount = requireData(await service.from("referrals").select("referred_user_id", { count: "exact" }).eq("referred_user_id", signup.user.id), "count referral relationships");
  assert.equal(duplicateCount.length, 1, "repeat signup must not duplicate or rebind the referral");

  const strangerClient = await signIn(strangerEmail);
  const hiddenRelationships = requireData(await strangerClient.from("referrals").select("referred_user_id"), "read referrals as stranger");
  assert.equal(hiddenRelationships.length, 0, "RLS must hide another user's referral list");
  const strangerOverview = requireData(await strangerClient.rpc("get_my_referral_overview"), "load stranger overview");
  assert.equal(strangerOverview.count, 0);

  console.log("referral registration integration passed");
} finally {
  if (createdUserIds.length) await service.from("accounts").delete().in("owner_id", createdUserIds);
  for (const userId of createdUserIds.reverse()) await service.auth.admin.deleteUser(userId);
}
