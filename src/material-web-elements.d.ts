import type { DetailedHTMLProps, HTMLAttributes } from 'react';

type MaterialElementProps<T extends HTMLElement = HTMLElement> = DetailedHTMLProps<HTMLAttributes<T>, T> & {
	anchor?: string;
	autofocus?: boolean;
	disabled?: boolean;
	indeterminate?: boolean;
	quick?: boolean;
	selected?: boolean;
	type?: 'button' | 'submit' | 'reset';
};

declare module 'react' {
	namespace JSX {
		interface IntrinsicElements {
			'md-circular-progress': MaterialElementProps;
			'md-dialog': MaterialElementProps;
			'md-elevated-button': MaterialElementProps;
			'md-filled-tonal-button': MaterialElementProps;
			'md-icon': MaterialElementProps;
			'md-menu': MaterialElementProps;
			'md-menu-item': MaterialElementProps;
			'md-outlined-button': MaterialElementProps;
			'md-outlined-card': MaterialElementProps;
			'md-outlined-icon-button': MaterialElementProps;
		}
	}
}
