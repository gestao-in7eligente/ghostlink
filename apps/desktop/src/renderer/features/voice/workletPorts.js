// Loaded into the voice AudioContext's AudioWorklet scope before the noise suppressors.
// Their processors listen with port.addEventListener('message') and never call port.start(),
// so the "destroy" message of a replaced suppressor would never arrive and it would keep
// running, with its WebAssembly state, until the context closes. Starting a port when it
// gets a message listener (what `onmessage =` does by itself) lets destroy() reach them.
/* global MessagePort */
const addEventListener = MessagePort.prototype.addEventListener;
MessagePort.prototype.addEventListener = function (type, listener, options) {
  addEventListener.call(this, type, listener, options);
  if (type === 'message') this.start();
};
