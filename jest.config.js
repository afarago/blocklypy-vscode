/** @type {import("jest").Config} **/
module.exports = {
    testEnvironment: 'node',
    preset: 'ts-jest',
    transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
    },
    testPathIgnorePatterns: ['/temp/'],
    transformIgnorePatterns: [
        '/node_modules/(?!blocklypy/)', // transform blocklypy
    ],
    moduleNameMapper: {
        '^blocklypy$': '<rootDir>/__mocks__/blocklypy.js',
        '^@abandonware/noble$': '<rootDir>/__mocks__/@abandonware/noble.js',
        '^usb/dist/usb/endpoint$': '<rootDir>/__mocks__/usb.js',
        '^usb$': '<rootDir>/__mocks__/usb.js',
    },
    roots: ['<rootDir>/src', '<rootDir>/__mocks__'],
};
