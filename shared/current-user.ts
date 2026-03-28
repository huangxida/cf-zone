export type CurrentUserSource = 'access' | 'header' | 'mock' | 'none';

export type CurrentUserProfile = {
	name: string;
	email: string;
	avatarUrl: string | null;
	initials: string;
	provider: string | null;
};

export type CurrentUserResponse = {
	authenticated: boolean;
	user: CurrentUserProfile | null;
	logoutUrl: string | null;
	source: CurrentUserSource;
};
