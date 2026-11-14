// ng serve only. Production must serve /api on the same origin as the UI.
const target = process.env.ORGANIZATIONS_API_TARGET;
const context = process.env.ORGANIZATIONS_API_PATH || '/api';
if (target && !/^https?:\/\//.test(target)) {
  throw new Error('ORGANIZATIONS_API_TARGET must be an HTTP(S) URL.');
}
if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(context)) {
  throw new Error('ORGANIZATIONS_API_PATH must be a root-relative path.');
}
const proxy = {};
if (target) {
  proxy[`${context}/**`] = {
    target,
    changeOrigin: true,
    secure: true,
    cookieDomainRewrite: '',
  };
}
module.exports = proxy;
