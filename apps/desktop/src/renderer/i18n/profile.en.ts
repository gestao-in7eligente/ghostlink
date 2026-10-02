import type { profile as profilePt } from './profile.pt-BR.js';

// Typed against the pt-BR namespace: a missing or extra key fails the typecheck.
export const profile: Record<keyof typeof profilePt, string> = {
  'profile.photo.title': 'Profile photo',
  'profile.photo.change': 'Change photo',
  'profile.photo.remove': 'Remove photo',
  'profile.photo.hint': 'The same photo is used on every server. PNG, JPEG, WebP or GIF, up to 10 MB; animated GIFs stay animated.',
  'profile.photo.unreadable': 'Couldn’t open this image.',

  'profile.crop.title': 'Edit image',
  'profile.crop.frame': 'Drag the image to frame it. The arrow keys move it too.',
  'profile.crop.zoom': 'Zoom',
  'profile.crop.reset': 'Reset',
  'profile.crop.apply': 'Apply',
  'profile.crop.applying': 'Applying…',
  'profile.crop.tooLarge': 'GIF too large. Try a shorter one or one with fewer colors.',

  'serverIcon.title': 'Server icon',
  'serverIcon.change': 'Change icon',
  'serverIcon.remove': 'Remove icon',
  'serverIcon.hint': 'Everyone sees it in the server rail and the header. PNG, JPEG, WebP or GIF, up to 10 MB; animated GIFs stay animated. Without one, the name’s initials.',

  'profileCard.label': '{name}’s profile',
  'profileCard.more': 'More options',
  'profileCard.memberSince': 'Member since',
  'profileCard.removeRole': 'Remove the {role} role',
  'profileCard.addRole': 'Add role',
  'profileCard.addRoleTo': 'Roles to give {name}',
  'profileCard.copyId': 'Copy user ID',
};
