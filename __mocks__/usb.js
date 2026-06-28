class WebUSB {}

const usb = {
    on: jest.fn(),
    off: jest.fn(),
};

module.exports = { WebUSB, usb };
