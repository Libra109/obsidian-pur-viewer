export const svgFixture = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2" fill="none">' +
  '<defs><linearGradient id="a"><stop stop-color="#ff0000"/>' +
  '<stop offset="1" stop-color="#ff0000"/></linearGradient></defs>' +
  '<path fill="url(#a)" d="M0 0h2v2H0z"/></svg>');
