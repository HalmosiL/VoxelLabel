import "@testing-library/jest-dom/vitest";

// jsdom has no layout: GuideTour scrolls its target into view on each
// step, which is a no-op here.
Element.prototype.scrollIntoView = () => {};
