export {};

declare global {
  interface Window {
    electroview?: import("electrobun/view").Electroview<import("./shared/types").DesktopRPC>;
  }
}
