class WebUSB {}
class InEndpoint {}
class OutEndpoint {}

const usb = {
    on: jest.fn(),
    off: jest.fn(),
};

module.exports = { WebUSB, usb, InEndpoint, OutEndpoint };
