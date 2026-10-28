export interface Business {
  id: string;
  name?: string;
}

/** A person in a Business Manager, by their business-scoped id. */
export interface BusinessUser {
  id: string;
  name?: string;
  email?: string;
  role?: string;
}

export interface SystemUser {
  id: string;
  name?: string;
  role?: string;
}

/** A person or system user with access to an asset, as `/{asset}/assigned_users` returns it. */
export interface AssignedUser {
  id: string;
  name?: string;
  user_type?: string;
  tasks?: string[];
}
