export const ROLES = {
  CREW_MEMBER: "Crew Member",
  PROJECT_MANAGER: "Project Manager",
  ACCOUNT_MANAGER: "Account Manager",
  OPERATIONS_MANAGER: "Operations Manager",
  SERVICE: "Service Department",
  ADMIN: "Administrator",
};
export function hasAnyRole(user, ...roles) {
  if (!user) return false;
  if (user.roles?.includes(ROLES.ADMIN)) return true;
  return roles.some((r) => user.roles?.includes(r));
}
export function isRole(user, role) {
  return !!user?.roles?.includes(role);
}
export function primaryRole(user) {
  if (!user?.roles?.length) return "";
  const order = [
    ROLES.ADMIN, ROLES.OPERATIONS_MANAGER, ROLES.PROJECT_MANAGER,
    ROLES.ACCOUNT_MANAGER, ROLES.SERVICE, ROLES.CREW_MEMBER,
  ];
  for (const r of order) if (user.roles.includes(r)) return r;
  return user.roles[0];
}
/** True if the user is designated crew chief for any department on this specific job. */
export function isJobCrewChief(user, job) {
  if (!user || !job) return false;
  return (job.crew || []).some((c) => c.user_id === user.id && c.is_crew_chief);
}
export function canApprovePrepAdd(user) {
  return hasAnyRole(user, ROLES.PROJECT_MANAGER);
}
export function canSubmitPrepAdd(user, job) {
  return isJobCrewChief(user, job) || hasAnyRole(user, ROLES.PROJECT_MANAGER);
}
export function canSubmitIdealPrep(user, job) {
  return isJobCrewChief(user, job) || hasAnyRole(user, ROLES.ADMIN);
}
export function canApproveIdealPrep(user) {
  return hasAnyRole(user, ROLES.PROJECT_MANAGER, ROLES.OPERATIONS_MANAGER);
}
export function canManageUsers(user) {
  return hasAnyRole(user, ROLES.PROJECT_MANAGER);
}
export function canManageFaults(user) {
  return hasAnyRole(user, ROLES.SERVICE, ROLES.OPERATIONS_MANAGER);
}
export function canEditJob(user, job) {
  if (isRole(user, ROLES.ADMIN)) return true;
  return isRole(user, ROLES.PROJECT_MANAGER) && job?.project_manager_id === user?.id;
}